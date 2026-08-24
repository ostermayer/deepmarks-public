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
//      If local exceeds the server by even one bookmark, gap exists → republish.
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

const MARKER_PREFIX = 'dm:auto-republish:v2:done:';
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/** After an interrupted run (signer dropped mid-encryption, relay query
 *  timed out) back off this long before retrying instead of re-firing on
 *  the very next canSign tick. Without a backoff, a flapping signer — or a
 *  public-count gap that never closes — re-enqueues the same templates in
 *  a tight loop, which surfaces to the user as a "waiting to sync" banner
 *  that blinks on and off. */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
/** Skip auto-republish for libraries under this size — they're
 *  either brand-new accounts (nothing to migrate) or so small the
 *  user won't notice the difference. */
const MIN_LOCAL_BOOKMARKS_TO_TRIGGER = 5;
/** Min gap (local - server) before we consider it worth a full
 *  republish run. Keep this strict: mobile share-extension saves
 *  must self-heal even when only one bookmark missed the server cache. */
const MIN_PUBLIC_GAP = 1;

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
    // Either the signer flipped to unavailable mid-encryption, or a
    // relay query for the chunk set timed out. Stamp a short backoff
    // (not the full TTL) so we retry later without re-running — and
    // re-enqueuing — on every subsequent signer-ready tick.
    localStorage.setItem(markerKey, String(Date.now() - MARKER_TTL_MS + FAILURE_BACKOFF_MS));
  } finally {
    inFlight = false;
  }
}
