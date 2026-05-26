// Batch publisher — async-iterable interface so the UI can render progress
// as items are signed and accepted by relays. Splits public vs private:
//   - public  → one kind:39701 per item
//   - private → batched into a single replaceable kind:30003 set update
//
// Rate limiting: at most `concurrency` in-flight publishes at once. Failures
// are isolated — one bad URL never aborts the batch.

import type { BookmarkInput, ParsedBookmark, UnsignedEventTemplate } from '$lib/nostr/bookmarks';
import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
import { publishEvent } from '$lib/nostr/publish';
import {
  bookmarkInputToInnerTags,
  buildPrivateSetReplacementEventStream,
  chunkPrivateSetEntries,
  fetchOwnPrivateSet,
  privateSetIndexFromName
} from '$lib/nostr/private-bookmarks';
import {
  isTransientSignerConnectionError,
  refreshBrowserExtensionSigner,
} from '$lib/stores/session';

export interface BatchOptions {
  visibility: 'private' | 'public';
  ownerPubkey: string;
  concurrency?: number;
}

export interface BatchEvent {
  index: number;
  total: number;
  url: string;
  status: 'prepared' | 'ok' | 'failed' | 'skipped';
  phase: 'bookmark' | 'private-set-encrypt' | 'private-set' | 'archive';
  completedUnits: number;
  totalUnits: number;
  error?: string;
  eventId?: string;
  bookmark?: ParsedBookmark;
  detail?: string;
}

/**
 * Publish a list of bookmarks. Yields one BatchEvent per item.
 *
 * For private visibility we accumulate everything in memory, append to the
 * existing kind:30003 set, and publish a single updated event at the end —
 * one replaceable per import keeps the relay clean and matches what flow A
 * does for individual saves.
 */
export async function* publishBatch(
  inputs: BookmarkInput[],
  opts: BatchOptions
): AsyncGenerator<BatchEvent, void, void> {
  const total = inputs.length;
  if (opts.visibility === 'public') {
    yield* publishPublicBatch(inputs, opts.ownerPubkey, opts.concurrency ?? 4, total);
  } else {
    yield* publishPrivateBatch(inputs, opts.ownerPubkey, total);
  }
}

async function* publishPublicBatch(
  inputs: BookmarkInput[],
  pubkey: string,
  concurrency: number,
  total: number
): AsyncGenerator<BatchEvent, void, void> {
  // Process in slabs so we can yield progress as each item resolves.
  for (let i = 0; i < inputs.length; i += concurrency) {
    const slab = inputs.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      slab.map(async (input) => {
        const template = buildBookmarkEvent(input);
        const result = await withImportSignerRetry(
          () => publishEvent(template, pubkey),
          pubkey,
          'signing this public bookmark',
        );
        return { input, template, eventId: result.eventId };
      })
    );
    for (let j = 0; j < slab.length; j++) {
      const input = slab[j]!;
      const r = results[j]!;
      const completedUnits = i + j + 1;
      if (r.status === 'fulfilled') {
        yield {
          index: i + j,
          total,
          url: input.url,
          status: 'ok',
          phase: 'bookmark',
          completedUnits,
          totalUnits: total,
          eventId: r.value.eventId,
          bookmark: parsedBookmarkFromInput(
            r.value.input,
            pubkey,
            r.value.template.created_at,
            r.value.eventId,
          ),
        };
      } else {
        yield {
          index: i + j,
          total,
          url: input.url,
          status: 'failed',
          phase: 'bookmark',
          completedUnits,
          totalUnits: total,
          error: (r.reason as Error)?.message ?? 'unknown error'
        };
      }
    }
  }
}

async function* publishPrivateBatch(
  inputs: BookmarkInput[],
  pubkey: string,
  total: number
): AsyncGenerator<BatchEvent, void, void> {
  // Build the new set off the existing one so we never wipe state.
  const existing = await fetchOwnPrivateSet(pubkey);
  const byUrl = new Map<string, string[][]>();
  for (const entry of existing.entries) {
    const url = entry.find((t) => t[0] === 'd')?.[1];
    if (url) byUrl.set(url, entry);
  }
  const itemEvents: BatchEvent[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    try {
      const template = buildBookmarkEvent(input);
      const innerTags = bookmarkInputToInnerTags(input);
      const url = innerTags.find((t) => t[0] === 'd')?.[1] ?? input.url;
      byUrl.set(url, innerTags);
      itemEvents.push({
        index: i,
        total,
        url: input.url,
        status: 'prepared',
        phase: 'bookmark',
        completedUnits: i + 1,
        totalUnits: total,
        eventId: `private:${url}`,
        bookmark: parsedBookmarkFromInput(input, pubkey, template.created_at, `private:${url}`),
      });
    } catch (e) {
      itemEvents.push({
        index: i,
        total,
        url: input.url,
        status: 'failed',
        phase: 'bookmark',
        completedUnits: i + 1,
        totalUnits: total,
        error: (e as Error).message,
      });
    }
  }
  const itemPreparedCount = itemEvents.filter((event) => event.status === 'prepared').length;
  const entries = Array.from(byUrl.values());
  const publishCount = itemPreparedCount > 0 ? privateSetPublishCount(entries, existing.chunkNames) : 0;
  const totalUnits = total * 2 + publishCount;
  for (const event of itemEvents) yield { ...event, totalUnits };
  if (itemPreparedCount === 0) return;

  // NIP-44 plaintext is capped at 65,535 bytes. Large imports are split
  // across multiple replaceable kind:30003 chunks.
  let templates: UnsignedEventTemplate[];
  let encryptedEntryUnits = 0;
  try {
    templates = [];
    for await (const step of buildPrivateSetReplacementEventStream({ entries }, pubkey, existing.chunkNames)) {
      templates.push(step.template);
      encryptedEntryUnits += step.entryCount;
      yield {
        index: total + step.index,
        total,
        url: `<encrypt set ${step.index + 1}/${step.count}>`,
        status: 'prepared',
        phase: 'private-set-encrypt',
        completedUnits: Math.min(total * 2, total + encryptedEntryUnits),
        totalUnits,
        detail: `encrypted private set chunk ${step.index + 1}/${step.count}`,
      };
    }
  } catch (e) {
    yield {
      index: total,
      total,
      url: '<set>',
      status: 'failed',
      phase: 'private-set-encrypt',
      completedUnits: Math.min(total * 2, total + encryptedEntryUnits),
      totalUnits,
      error: privateSetFailureMessage(e),
    };
    return;
  }
  for (let i = 0; i < templates.length; i++) {
    const completedUnits = total * 2 + i + 1;
    try {
      const result = await withImportSignerRetry(
        () => publishEvent(templates[i]!, pubkey),
        pubkey,
        'publishing the private bookmark set',
      );
      yield {
        index: total + i,
        total,
        url: `<set ${i + 1}/${templates.length}>`,
        status: 'ok',
        phase: 'private-set',
        completedUnits,
        totalUnits,
        detail: `published private set chunk ${i + 1}/${templates.length}`,
        eventId: result.eventId
      };
    } catch (e) {
      yield {
        index: total + i,
        total,
        url: `<set ${i + 1}/${templates.length}>`,
        status: 'failed',
        phase: 'private-set',
        completedUnits,
        totalUnits,
        error: privateSetFailureMessage(e)
      };
    }
  }
}

async function withImportSignerRetry<T>(
  run: () => Promise<T>,
  pubkey: string,
  action: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransientSignerConnectionError(error) || attempt === 2) break;
      await refreshBrowserExtensionSigner(pubkey);
      await delay(250 * (attempt + 1));
    }
  }
  if (isTransientSignerConnectionError(lastError)) {
    throw new Error(
      `Browser extension connection dropped while ${action}. Reopen or reload the extension, then retry the import.`,
    );
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'unknown error'));
}

function privateSetFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return `${message} The private import was not completed or cached. Retry is safe; Deepmarks replaces duplicates by URL.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function privateSetPublishCount(entries: string[][][], previousChunkNames: string[] = []): number {
  const chunks = chunkPrivateSetEntries(entries);
  const previousMaxIndex = previousChunkNames.reduce((max, name) => {
    const idx = privateSetIndexFromName(name);
    return idx === null ? max : Math.max(max, idx);
  }, -1);
  return Math.max(chunks.length, previousMaxIndex + 1, 1);
}

function parsedBookmarkFromInput(
  input: BookmarkInput,
  pubkey: string,
  savedAt: number,
  eventId: string,
): ParsedBookmark {
  return {
    url: input.url,
    title: input.title?.trim() || input.url,
    description: input.description?.trim() ?? '',
    tags: [...(input.tags ?? [])],
    publishedAt: input.publishedAt,
    lightning: input.lightning,
    blossomHash: input.blossomHash,
    waybackUrl: input.waybackUrl,
    archivedForever: !!input.archivedForever,
    savedAt,
    curator: pubkey,
    eventId,
  };
}
