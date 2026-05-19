// Auto-republish: silent migration helper that fires after signer-
// ready and only when the local cache holds meaningfully more
// bookmarks than the canonical relay has.
//
// The user doesn't have to know about it. The settings page still
// has the manual "republish to relay" button for power users +
// support purposes, but for most accounts this fires once on first
// login post-deploy, fills the gap, and never bothers them again.
//
// Detection heuristic:
//
//   1. `dm:auto-republish:done:<pubkey>` localStorage marker is
//      stamped each run. If it's <24h old, skip.
//   2. Local ownBookmarks count needs to clear a small floor so we
//      don't bother brand-new accounts with empty libraries.
//   3. Compare local PUBLIC count to api.publicBookmarks count.
//      If local exceeds by 5+, gap exists → republish.
//      Private is harder to compare cheaply (would need a full
//      fetch + decrypt) so we trust the addressable-replaceable
//      semantics: re-encrypting + republishing the same set is a
//      no-op on the relay side. Once the public gap clears we
//      assume private also did.
//
// Idempotent: re-running same content fills the pending-publish
// queue with templates the drainer already dedups by key.

import { get } from 'svelte/store';
import { ownBookmarks } from '$lib/stores/own-bookmarks';
import { api } from '$lib/api/client';
import { canSign, currentSession } from '$lib/stores/session';

const MARKER_PREFIX = 'dm:auto-republish:done:';
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/** Skip auto-republish for libraries under this size — they're
 *  either brand-new accounts (nothing to migrate) or so small the
 *  user won't notice the difference. */
const MIN_LOCAL_BOOKMARKS_TO_TRIGGER = 5;
/** Min gap (local - server) before we consider it worth a full
 *  republish run. Small drifts (1-2 entries that haven't reached
 *  the indexer yet) are normal and self-heal. */
const MIN_PUBLIC_GAP = 5;

let inFlight = false;

export async function maybeAutoRepublish(pubkey: string): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  if (inFlight) return;
  if (!get(canSign)) return;
  if (currentSession().pubkey !== pubkey) return;

  const markerKey = MARKER_PREFIX + pubkey;
  const lastRun = Number(localStorage.getItem(markerKey) ?? '0');
  if (Number.isFinite(lastRun) && Date.now() - lastRun < MARKER_TTL_MS) return;

  const bookmarks = get(ownBookmarks);
  if (bookmarks.length < MIN_LOCAL_BOOKMARKS_TO_TRIGGER) return;

  const localPublic = bookmarks.filter(
    (b) => !b.eventId?.startsWith('private:'),
  ).length;

  let serverPublicCount = 0;
  try {
    // Server-side cache count. limit=5000 gives us a generous
    // upper bound; api.publicBookmarks's response includes `count`
    // (returned count) which we treat as a proxy for how much is
    // available on the relay-cached path.
    const res = await api.publicBookmarks(pubkey, 5000);
    serverPublicCount = res.count;
  } catch {
    // API unreachable — bail out and try again on the next
    // canSign tick. Better to skip than to mis-detect a gap and
    // schedule unnecessary publishes.
    return;
  }

  const publicGap = localPublic - serverPublicCount;
  if (publicGap < MIN_PUBLIC_GAP) {
    // Already in sync. Mark and bail so we don't recompute for 24h.
    localStorage.setItem(markerKey, String(Date.now()));
    return;
  }

  // Real gap detected. Fire both halves through the existing
  // republishAllOwnBookmarks generator. The async iteration drives
  // template-encryption + enqueue; the durable-publish queue takes
  // over from there.
  inFlight = true;
  try {
    const { republishAllOwnBookmarks } = await import('./republish-all.js');
    // Private set first — one chunked encrypted republish, capped
    // to ~25 templates in practice. Then per-public-bookmark.
    for await (const _step of republishAllOwnBookmarks(pubkey, 'private')) {
      // step.detail is plumbed but auto-republish is silent —
      // RepublishToRelaySection in settings shows progress for the
      // manual case.
    }
    for await (const _step of republishAllOwnBookmarks(pubkey, 'public')) {
      // (no UI)
    }
    localStorage.setItem(markerKey, String(Date.now()));
  } catch {
    // Either the signer flipped to unavailable mid-encryption, or
    // a relay query for the chunk set timed out. We don't mark
    // done; the next signer-ready tick (or app load) re-runs the
    // check.
  } finally {
    inFlight = false;
  }
}
