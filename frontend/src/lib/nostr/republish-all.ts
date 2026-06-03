// Emergency re-sync helper.
//
// When a user's local cache holds far more bookmarks than the relay
// can serve (e.g. after an import where most private-set chunks failed
// mid-publish, leaving the data trapped on a single device), this
// helper walks the local ownBookmarks store and enqueues every
// resulting event into the durable publish queue. The queue drains
// progressively on app load / foreground / signer-ready, so the user
// can close the app and the publishes keep happening in the
// background instead of requiring them to babysit the phone for an
// hour straight.
//
// Public bookmarks → one signed kind:39701 per URL.
// Private bookmarks → chunked encrypted kind:30003 set (NIP-44 to
// self), one event per chunk. Encryption happens up-front when we
// build the templates; the queue just handles signing + publishing.

import { get } from 'svelte/store';
import { ownBookmarks } from '$lib/stores/own-bookmarks';
import {
  buildBookmarkEvent,
  type BookmarkInput,
  type UnsignedEventTemplate,
} from './bookmarks.js';
import {
  bookmarkInputToInnerTags,
  buildPrivateSetReplacementEventStream,
} from './private-bookmarks.js';
import { enqueuePendingPublish, drainPendingPublishes } from './pending-publish.js';

export interface RepublishProgress {
  total: number;
  queued: number;
  phase: 'preparing' | 'queued' | 'draining' | 'done';
  detail?: string;
}

export async function* republishAllOwnBookmarks(
  pubkey: string,
  visibility: 'public' | 'private',
): AsyncGenerator<RepublishProgress, void, void> {
  const all = get(ownBookmarks);
  const isPrivateOwn = (b: { eventId: string }) => b.eventId.startsWith('private:');
  const slice = visibility === 'private'
    ? all.filter(isPrivateOwn)
    : all.filter((b) => !isPrivateOwn(b));

  if (slice.length === 0) {
    yield { total: 0, queued: 0, phase: 'done', detail: 'nothing to push' };
    return;
  }

  const inputs: BookmarkInput[] = slice.map((b) => ({
    url: b.url,
    title: b.title === b.url ? undefined : b.title,
    description: b.description || undefined,
    tags: b.tags,
    lightning: b.lightning,
    archivedForever: b.archivedForever,
    // Preserve the original save timestamp. Without this, every
    // re-published entry loses its `published_at` inner tag and
    // parsePrivateEntry falls back to the chunk's created_at, which
    // — on a republish — is "now". The net effect: every old
    // bookmark gets the same fresh timestamp and the newest-first
    // sort collapses across all entries that rode this re-sync.
    publishedAt: b.publishedAt ?? b.savedAt,
    publishedAtMs: b.savedAtMs,
  }));

  yield { total: slice.length, queued: 0, phase: 'preparing', detail: 'building events…' };

  let queued = 0;

  if (visibility === 'public') {
    for (const input of inputs) {
      const template: UnsignedEventTemplate = buildBookmarkEvent(input);
      enqueuePendingPublish(template, pubkey, 're-sync requested');
      queued += 1;
      if (queued % 25 === 0 || queued === inputs.length) {
        yield {
          total: slice.length,
          queued,
          phase: 'queued',
          detail: `${queued}/${slice.length} queued`,
        };
      }
    }
  } else {
    // Private set is chunked. Build the entries vector first, then
    // walk the encryption stream — each yield gives us one encrypted
    // chunk ready to sign + publish.
    const entries: string[][][] = [];
    for (const input of inputs) {
      entries.push(bookmarkInputToInnerTags(input));
    }
    let chunkIndex = 0;
    for await (const step of buildPrivateSetReplacementEventStream(
      { entries },
      pubkey,
    )) {
      enqueuePendingPublish(step.template, pubkey, 're-sync requested');
      queued += 1;
      chunkIndex = step.index + 1;
      yield {
        total: slice.length,
        queued,
        phase: 'queued',
        detail: `chunk ${chunkIndex}/${step.count} encrypted + queued`,
      };
    }
  }

  yield {
    total: slice.length,
    queued,
    phase: 'draining',
    detail: 'publishing in the background — safe to close the app',
  };

  // Kick the drainer once so the first batch starts immediately;
  // subsequent batches drain on every foreground / load.
  await drainPendingPublishes(pubkey).catch(() => { /* drain errors are individually surfaced */ });

  yield {
    total: slice.length,
    queued,
    phase: 'done',
    detail: 'queued for background publish — keep using the app normally',
  };
}
