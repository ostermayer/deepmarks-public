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
// ADDITIVE: both halves first read what the relay already has and only
// (re)publish bookmarks that are MISSING there. The old behavior —
// re-sign everything from the local snapshot — could re-assert a stale
// device's state over newer edits and resurrect deleted bookmarks
// (audit finding SYNC-F3). Public → one kind:39701 per missing URL;
// private → one per-item encrypted event per missing URL (never a
// whole-set chunk rewrite).

import { get } from 'svelte/store';
import { ownBookmarks } from '$lib/stores/own-bookmarks';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { canonicalRelaySet } from './canonical-relay-set.js';
import {
  buildBookmarkEvent,
  type BookmarkInput,
  type UnsignedEventTemplate,
} from './bookmarks.js';
import {
  buildPrivateItemEvent,
  fetchOwnPrivateSet,
} from './private-bookmarks.js';
import { privateEntryUrl } from './private-set-core.js';
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

  yield { total: slice.length, queued: 0, phase: 'preparing', detail: 'checking what the relay already has…' };

  let queued = 0;

  if (visibility === 'public') {
    // Relay truth: every kind:39701 the canonical relay serves for this
    // author. Only URLs absent there get (re)published — identical
    // copies are wasted budget and stale copies would clobber edits.
    const relayUrls = new Set<string>();
    try {
      const ndk = getNdk();
      const relaySet = canonicalRelaySet([]);
      const events = await ndk.fetchEvents(
        { kinds: [KIND.webBookmark as number], authors: [pubkey], limit: 2000 },
        relaySet ? { groupable: false } : undefined,
        relaySet ?? undefined,
      );
      for (const event of events) {
        const url = event.tags.find((t: string[]) => t[0] === 'd')?.[1];
        if (url) relayUrls.add(url);
      }
    } catch {
      yield { total: slice.length, queued: 0, phase: 'done', detail: 'relay unreachable — skipped (re-run later)' };
      return;
    }
    const missing = inputs.filter((input) => !relayUrls.has(input.url));
    for (const input of missing) {
      const template: UnsignedEventTemplate = buildBookmarkEvent(input);
      enqueuePendingPublish(template, pubkey, 're-sync requested');
      queued += 1;
      if (queued % 25 === 0 || queued === missing.length) {
        yield {
          total: missing.length,
          queued,
          phase: 'queued',
          detail: `${queued}/${missing.length} missing on relay queued`,
        };
      }
    }
    if (missing.length === 0) {
      yield { total: slice.length, queued: 0, phase: 'done', detail: 'relay already has everything' };
      return;
    }
  } else {
    let relaySet;
    try {
      relaySet = await fetchOwnPrivateSet(pubkey);
    } catch {
      yield { total: slice.length, queued: 0, phase: 'done', detail: 'relay unreachable — skipped (re-run later)' };
      return;
    }
    if (relaySet.decryptFailures && relaySet.decryptFailures > 0) {
      yield {
        total: slice.length,
        queued: 0,
        phase: 'done',
        detail: 'relay set partially unreadable — skipped to avoid clobbering. Reconnect your signer and re-run.',
      };
      return;
    }
    const relayUrls = new Set(relaySet.entries.map((entry) => privateEntryUrl(entry)).filter(Boolean));
    const deleted = relaySet.deletedUrls ?? {};
    const missing = inputs.filter((input) => {
      if (relayUrls.has(input.url)) return false;
      const deletedAt = deleted[input.url];
      // A tombstone at least as new as our copy means another device
      // deleted it — do not resurrect.
      return !(deletedAt !== undefined && deletedAt >= (input.publishedAt ?? 0));
    });
    for (const input of missing) {
      const template = await buildPrivateItemEvent(input, pubkey);
      enqueuePendingPublish(template, pubkey, 're-sync requested');
      queued += 1;
      if (queued % 25 === 0 || queued === missing.length) {
        yield {
          total: missing.length,
          queued,
          phase: 'queued',
          detail: `${queued}/${missing.length} missing on relay queued`,
        };
      }
    }
    if (missing.length === 0) {
      yield { total: slice.length, queued: 0, phase: 'done', detail: 'relay already has everything' };
      return;
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
