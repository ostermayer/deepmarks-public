// Silent background drain for pending shares from native share sheets.
//
// The iOS Share Extension persists each save to AppGroup UserDefaults;
// the Android share activity persists the same payload shape in native
// SharedPreferences. Both survive a denied or failed deep link. Whether
// `deepmarks://save?pendingShareId=…` fires or not, the host app drains
// pending shares the next time it becomes active.
//
// Why drain (silent save) instead of navigating to /app/save?
//   - The user shares from Safari and expects to see the bookmark in
//     the list when they open the app — not to be dropped onto a
//     /save form. Especially: pull-to-refresh re-mounts the layout,
//     which would otherwise re-fire the navigation and yank the user
//     off whatever tab they were on.
//   - Saving silently and reflecting in own-bookmarks is the same UX
//     as saving from the in-app SaveBox; just no form.
//
// Triggers (all converge on the same idempotent drain function):
//   - Cold start, after setupDeepLinks runs
//   - App foreground (Capacitor appStateChange isActive=true)
//   - Live deepmarks://save?pendingShareId=… deep link
//
// The drain is single-flight (overlapping calls coalesce). It waits up
// to ~25 seconds for a signer to become available before giving up —
// pending shares stay in native storage so the next foreground retries.

import { get, writable } from 'svelte/store';
import { canSign, currentSession, session, sessionRestoring } from '$lib/stores/session';
import {
  getPendingSharedBookmark,
  removePendingSharedBookmark,
  type PendingSharedBookmark,
} from '$lib/mobile/secure-store';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import type { UserSettings } from '$lib/stores/user-settings';

export interface ShareDrainResult {
  saved: number;
  failed: number;
  message?: string;
  /** Monotonic counter so the toast renders even when the message text
   *  repeats (saved=1 twice in a row). */
  seq: number;
}

const initial: ShareDrainResult = { saved: 0, failed: 0, seq: 0 };
export const lastShareDrainResult = writable<ShareDrainResult>(initial);

const MAX_DRAIN_PER_RUN = 20;
const SIGNER_WAIT_TIMEOUT_MS = 25_000;
const SIGNER_WAIT_INTERVAL_MS = 250;
const SHARE_ACCOUNT_MISMATCH = 'SHARE_ACCOUNT_MISMATCH';
let draining = false;
let drainSeq = 0;

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const tag = part.trim().replace(/^#/, '').toLowerCase();
    if (!tag || seen.has(tag) || tag.length > 48) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function readLaterFromShare(share: PendingSharedBookmark, tags: string[]): boolean {
  if (share.readLater === '1' || share.readLater === 'true') return true;
  if (share.readLater === '0' || share.readLater === 'false') return false;
  return tags.includes('toread');
}

function isPublicFromShare(share: PendingSharedBookmark, defaultPublic: boolean): boolean {
  const v = share.visibility;
  if (v === 'public') return true;
  if (v === 'private') return false;
  return defaultPublic;
}

function shareSavedAtMs(share: PendingSharedBookmark): number {
  const explicitMs = Number(share.createdAtMs);
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
  const seconds = Number(share.createdAt);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return Date.now();
}

function bookmarkFromNativePublishedShare(opts: {
  share: PendingSharedBookmark;
  tags: string[];
  pubkey: string;
  isPublic: boolean;
}): ParsedBookmark {
  const savedAtMs = shareSavedAtMs(opts.share);
  const savedAt = Math.floor(savedAtMs / 1000);
  const title = (opts.share.title ?? '').trim() || opts.share.url;
  return {
    url: opts.share.url,
    title,
    description: (opts.share.description ?? '').trim(),
    tags: opts.tags,
    publishedAt: savedAt,
    archivedForever: false,
    savedAt,
    savedAtMs,
    curator: opts.pubkey,
    eventId: opts.isPublic ? `optimistic:${opts.share.url}` : `private:${opts.share.url}`,
  };
}

async function waitForSigner(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < SIGNER_WAIT_TIMEOUT_MS) {
    if (get(canSign)) return true;
    // If the session has fully restored and there's still no signer,
    // give up early — no point sitting on a 25s timer when we know
    // the user isn't signed in.
    if (!get(sessionRestoring) && !currentSession().signer && !currentSession().pubkey) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SIGNER_WAIT_INTERVAL_MS));
  }
  return get(canSign);
}

/** Mirror of publish.ts:isTransientFetchError — same iOS-WKWebView
 *  failure modes the share-drain should treat as "queued for
 *  background retry" rather than user-visible "failed". */
function isTransientPublishError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'AbortError') return true;
  if (typeof e.message !== 'string') return false;
  return /network connection was lost|load failed|failed to fetch|connection reset|the request timed out|fetch is aborted|net::err_/i
    .test(e.message);
}

function isQueuedPublishError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = err instanceof Error ? err.message : String(err);
  // publishEvent enqueues templates after it has signed the event and
  // the /publish POST fails or returns non-2xx. At that point the
  // durable-publish queue owns retry, so the native share payload can be
  // consumed without telling the user the share failed.
  return /^publish \d+:/i.test(message) ||
    /could not sync this bookmark right now/i.test(message) ||
    /saved on this device and will retry automatically/i.test(message) ||
    /queued and will retry automatically/i.test(message);
}

async function processOne(share: PendingSharedBookmark): Promise<boolean> {
  const pubkey = currentSession().pubkey;
  if (!pubkey) throw new Error('not signed in');
  const ownerPubkey = share.ownerPubkey?.trim().toLowerCase();
  if (ownerPubkey && /^[0-9a-f]{64}$/.test(ownerPubkey) && ownerPubkey !== pubkey) {
    throw new Error(`${SHARE_ACCOUNT_MISMATCH}: sign in with the account that created this share to finish saving it`);
  }
  const { userSettings } = await import('$lib/stores/user-settings');
  const settings = get(userSettings);
  const explicitReadLater = share.readLater === '1' ||
    share.readLater === 'true' ||
    share.readLater === '0' ||
    share.readLater === 'false';
  const parsedTags = parseTags(share.tags);
  const tags = parsedTags.length === 0 && !explicitReadLater
    ? [...settings.defaultTags]
    : parsedTags;
  if (readLaterFromShare(share, tags) && !tags.includes('toread')) tags.push('toread');
  if ((share.readLater === '0' || share.readLater === 'false') && tags.includes('toread')) {
    tags.splice(tags.indexOf('toread'), 1);
  }

  const defaultPublic = settings.defaultVisibility === 'public';
  const isPublic = isPublicFromShare(share, defaultPublic);
  const { rememberOwnBookmark, rememberOwnBookmarkWithRollback } = await import('$lib/stores/own-bookmarks');

  // Fast path: the native share sheet already signed and POSTed the
  // kind:39701 to /publish before it dismissed. The bookmark is
  // already on the relay; all we have to do here is mirror it into
  // the local own-bookmarks store so the user sees it on the next
  // open without waiting for the relay subscription to deliver it
  // back. We use the standard optimistic ParsedBookmark shape so
  // the bookmark renders identically to one saved through the
  // SaveBox.
  if (share.published === '1') {
    const bookmark = bookmarkFromNativePublishedShare({ share, tags, pubkey, isPublic });
    rememberOwnBookmark(bookmark, isPublic);
    await queuePostSaveArchiveWork({ share, pubkey, isPublic, settings, bookmark });
    return true;
  }

  const { saveBookmark } = await import('$lib/nostr/save-bookmark');
  let optimisticApplied = false;
  const savedAtMs = shareSavedAtMs(share);
  try {
    const result = await saveBookmark({
      url: share.url,
      title: share.title,
      description: share.description,
      tags,
      isPublic,
      pubkey,
      savedAtMs,
      // Render the freshly-shared bookmark in the user's list
      // immediately on mobile — the chunk publish below takes seconds and
      // shouldn't gate the appearance of the entry.
      onOptimistic: (b) => {
        optimisticApplied = true;
        const rollback = rememberOwnBookmarkWithRollback(b, isPublic);
        return () => {
          rollback();
          optimisticApplied = false;
        };
      },
    });
    await queuePostSaveArchiveWork({
      share,
      pubkey,
      isPublic,
      eventId: isPublic ? result.eventId : undefined,
      bookmark: result.bookmark,
      settings,
    });
    return true;
  } catch (err) {
    if (optimisticApplied) {
      // The bookmark is already visible locally. Remove the native
      // share only when the durable-publish queue already owns retry;
      // otherwise leave it pending so a future foreground can retry
      // signing/publishing. Either way this should not become a scary
      // "share failed" toast.
      const retryOwnedByDurableQueue = isTransientPublishError(err) || isQueuedPublishError(err);
      if (!retryOwnedByDurableQueue) {
        console.warn('[deepmarks share-drain] saved locally, leaving pending share for retry', err);
      }
      return retryOwnedByDurableQueue;
    }
    if (isTransientPublishError(err) || isQueuedPublishError(err)) {
      return false;
    }
    throw err;
  }
}

async function queuePostSaveArchiveWork(opts: {
  share: PendingSharedBookmark;
  pubkey: string;
  isPublic: boolean;
  settings: UserSettings;
  bookmark: ParsedBookmark;
  eventId?: string;
}): Promise<void> {
  await maybeQueueDefaultArchive({
    share: opts.share,
    pubkey: opts.pubkey,
    isPublic: opts.isPublic,
    savedAt: opts.bookmark.savedAt,
    eventId: opts.eventId,
    settings: opts.settings,
  });
  void import('$lib/media-archive').then(({ maybeQueueMediaArchiveForBookmark }) => (
    maybeQueueMediaArchiveForBookmark({
      bookmark: opts.bookmark,
      url: opts.share.url,
      pubkey: opts.pubkey,
      eventId: opts.isPublic ? opts.eventId ?? opts.bookmark.eventId : undefined,
      bookmarkSavedAt: opts.bookmark.savedAt,
    })
  )).catch((error) => {
    console.warn('[deepmarks share-drain] media archive queue failed', error);
  });
}

async function maybeQueueDefaultArchive(opts: {
  share: PendingSharedBookmark;
  pubkey: string;
  isPublic: boolean;
  savedAt: number;
  eventId?: string;
  settings: UserSettings;
}): Promise<void> {
  const archiveByDefault = opts.settings.archiveAllByDefault || !opts.settings.archiveDefaultManualOverride;
  if (!archiveByDefault) return;
  try {
    const [{ isLifetimeMemberOnce }, { enqueueArchivePage }] = await Promise.all([
      import('$lib/nostr/lifetime-status'),
      import('$lib/nostr/archive'),
    ]);
    if (!await isLifetimeMemberOnce(opts.pubkey)) return;
    await enqueueArchivePage({
      url: opts.share.url,
      tier: opts.isPublic ? 'public' : 'private',
      pubkey: opts.pubkey,
      eventId: opts.eventId,
      bookmarkSavedAt: opts.savedAt,
      lifetime: true,
      mirrorUrls: opts.settings.backupBlossomServers,
      dedupe: true,
    });
  } catch (error) {
    console.warn('[deepmarks share-drain] bookmark saved, archive queue failed', error);
  }
}

/**
 * Drain pending shares from native storage. Single-flight: overlapping
 * calls return immediately. Returns the count saved/failed in this run.
 *
 * Logs to console so the drain is debuggable from native WebView
 * inspectors when a device is connected — chase down "I shared but the
 * bookmark didn't show up" without needing native log capture.
 */
export async function drainPendingShares(): Promise<ShareDrainResult> {
  if (draining) {
    console.log('[deepmarks share-drain] skipped — already in flight');
    return get(lastShareDrainResult);
  }
  draining = true;
  let saved = 0;
  let failed = 0;
  let message: string | undefined;
  console.log('[deepmarks share-drain] start');
  try {
    if (!get(session).pubkey && !get(sessionRestoring)) {
      console.log('[deepmarks share-drain] no session — nothing to drain');
      return { saved: 0, failed: 0, message: undefined, seq: ++drainSeq };
    }
    const haveSigner = await waitForSigner();
    if (!haveSigner) {
      console.log('[deepmarks share-drain] signer never became available — leaving pending shares for next foreground');
      return { saved: 0, failed: 0, message: undefined, seq: ++drainSeq };
    }

    for (let i = 0; i < MAX_DRAIN_PER_RUN; i++) {
      const share = await getPendingSharedBookmark();
      if (!share?.id || !share.url) {
        console.log(`[deepmarks share-drain] no more pending shares (processed ${saved})`);
        break;
      }
      console.log(`[deepmarks share-drain] processing share id=${share.id} url=${share.url}`);
      try {
        const removePending = await processOne(share);
        if (removePending) {
          saved += 1;
          console.log(`[deepmarks share-drain] saved id=${share.id}`);
          await removePendingSharedBookmark(share.id);
        } else {
          console.log(`[deepmarks share-drain] kept pending share for retry id=${share.id}`);
          break;
        }
      } catch (e) {
        const msg = (e as Error).message ?? 'save failed';
        if (msg.startsWith(SHARE_ACCOUNT_MISMATCH)) {
          failed += 1;
          message = msg.replace(`${SHARE_ACCOUNT_MISMATCH}: `, '');
          console.warn(`[deepmarks share-drain] account mismatch id=${share.id}: ${message}`);
          break;
        }
        if (isTransientPublishError(e)) {
          // processOne returns true for the safe case where the
          // bookmark is visible locally and the durable queue owns
          // retry. If a transient publish error reaches this outer
          // catch, keep the native share so the next foreground can
          // retry from source.
          console.warn(`[deepmarks share-drain] transient publish failure; kept pending id=${share.id}: ${msg}`);
          break;
        } else {
          failed += 1;
          message = msg;
          console.warn(`[deepmarks share-drain] save failed id=${share.id}`, e);
        }
        // Drop the share from native storage either way — the optimistic
        // remember + durable-publish queue (for transient) or the
        // permanent-failure visibility (for non-transient) carry it
        // forward without share-drain re-trying.
        await removePendingSharedBookmark(share.id).catch(() => undefined);
        if (!isTransientPublishError(e)) break;
        continue;
      }
    }
  } finally {
    draining = false;
  }

  const next: ShareDrainResult = {
    saved,
    failed,
    message,
    seq: ++drainSeq,
  };
  console.log('[deepmarks share-drain] done', next);
  lastShareDrainResult.set(next);
  return next;
}

/**
 * Debug hooks exposed on `window` so Safari Web Inspector can trigger
 * a drain on demand and read the current state. The native cold-start
 * drain often fires before the inspector attaches, so its logs are
 * lost; this gives a way to re-fire and watch.
 *
 * Usage from the Web Inspector console:
 *   await window.__deepmarksDrain()      // run a drain, returns the result
 *   window.__deepmarksDrainState()       // { draining, lastResult }
 *   await window.__deepmarksPeekShare()  // peek at the next pending share
 *                                          without consuming it
 */
declare global {
  interface Window {
    __deepmarksDrain?: () => Promise<ShareDrainResult>;
    __deepmarksDrainState?: () => { draining: boolean; lastResult: ShareDrainResult };
    __deepmarksPeekShare?: () => Promise<PendingSharedBookmark | null>;
  }
}

if (typeof window !== 'undefined') {
  window.__deepmarksDrain = () => drainPendingShares();
  window.__deepmarksDrainState = () => ({
    draining,
    lastResult: get(lastShareDrainResult),
  });
  window.__deepmarksPeekShare = () => getPendingSharedBookmark();
}
