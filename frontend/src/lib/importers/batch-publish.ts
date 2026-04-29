// Batch publisher — async-iterable interface so the UI can render progress
// as items are signed and accepted by relays. Splits public vs private:
//   - public  → one kind:39701 per item
//   - private → batched into a single replaceable kind:30003 set update
//
// Rate limiting: at most `concurrency` in-flight publishes at once. Failures
// are isolated — one bad URL never aborts the batch.

import type { BookmarkInput } from '$lib/nostr/bookmarks';
import { buildBookmarkEvent } from '$lib/nostr/bookmarks';
import { publishEvent } from '$lib/nostr/publish';
import {
  bookmarkInputToInnerTags,
  buildPrivateSetEvent,
  fetchOwnPrivateSet
} from '$lib/nostr/private-bookmarks';

export interface BatchOptions {
  visibility: 'private' | 'public';
  ownerPubkey: string;
  concurrency?: number;
}

export interface BatchEvent {
  index: number;
  total: number;
  url: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
  eventId?: string;
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
      slab.map((input) => publishEvent(buildBookmarkEvent(input), pubkey))
    );
    for (let j = 0; j < slab.length; j++) {
      const input = slab[j]!;
      const r = results[j]!;
      if (r.status === 'fulfilled') {
        yield {
          index: i + j,
          total,
          url: input.url,
          status: 'ok',
          eventId: r.value.eventId
        };
      } else {
        yield {
          index: i + j,
          total,
          url: input.url,
          status: 'failed',
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
  const accumulated = [...existing.entries];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    accumulated.push(bookmarkInputToInnerTags(input));
    yield { index: i, total, url: input.url, status: 'ok' };
  }
  // One single publish at the end. If this fails, surface as a synthetic
  // batch-level failure rather than per-item.
  try {
    const template = await buildPrivateSetEvent({ entries: accumulated }, pubkey);
    const result = await publishEvent(template, pubkey);
    yield {
      index: total,
      total,
      url: '<set>',
      status: 'ok',
      eventId: result.eventId
    };
  } catch (e) {
    yield {
      index: total,
      total,
      url: '<set>',
      status: 'failed',
      error: (e as Error).message
    };
  }
}
