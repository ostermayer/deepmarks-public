// Singleton: the URLs the signed-in user has already saved as
// bookmarks. Used by feed rows (search, recent, popular) to swap the
// 'save' button for a 'saved ✓' label when the user revisits a URL
// they already have on their list.
//
// Two sources merged into one Set<url>:
//   • public kind:39701 events — live createBookmarkFeed subscription
//   • private NIP-51 set (kind:30003 d='deepmarks-private-bookmarks')
//     — fetched + decrypted once canSign flips true; refetched on
//     pubkey change. Without this branch a private bookmark would
//     still show 'save' even though the user already has the URL.
//
// The subscription / fetch hang around for the layout lifetime so
// every row can do an O(1) Set.has() without spawning per-row queries.
// NDK's Dexie cache means revisits are instant.

import { writable, derived, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { session, canSign } from '$lib/stores/session';
import { createBookmarkFeed } from '$lib/nostr/feed';
import { createImportedBookmarksFeed, createImportedNoteRefsFeed } from '$lib/nostr/imported-bookmarks';
import { fetchOwnPrivateSet } from '$lib/nostr/private-bookmarks';
import { nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';

const publicUrls = writable<Set<string>>(new Set());
const importedUrls = writable<Set<string>>(new Set());
const importedNoteUrls = writable<Set<string>>(new Set());
const privateUrls = writable<Set<string>>(new Set());

/** Public read-only set of every URL the user has bookmarked, public
 *  + private merged. */
export const mySavedUrls: Readable<Set<string>> = derived(
  [publicUrls, importedUrls, importedNoteUrls, privateUrls],
  ([$pub, $imported, $importedNotes, $priv]) => {
    const merged = new Set<string>($pub);
    for (const u of $imported) merged.add(u);
    for (const u of $importedNotes) merged.add(u);
    for (const u of $priv) merged.add(u);
    return merged;
  },
);

/** Convenience: derived predicate so callers can write
 *  `$isSavedByMe(bookmark.url)` without re-deriving inside each row. */
export const isSavedByMe: Readable<(url: string) => boolean> = derived(
  mySavedUrls,
  ($u) => (url: string) => $u.has(url),
);

let started = false;
let lastPubkey: string | null = null;
let feedUnsub: (() => void) | null = null;
let importedUnsub: (() => void) | null = null;
let importedNotesUnsub: (() => void) | null = null;
let lastPrivateFetchPubkey: string | null = null;
let latestCanSign = false;
let importedNotesDecryptPrivate = false;
let importedUrlsDecryptPrivate = false;

/** Subscribe-once wiring — call from the root layout. Repeats are
 *  no-ops so a hot-reload during dev doesn't spawn duplicates. */
export function startMySavedUrlsLoader(): () => void {
  if (!browser || started) return () => {};
  started = true;

  const stopSession = session.subscribe((s) => {
    if (s.pubkey === lastPubkey) return;
    lastPubkey = s.pubkey;
    if (feedUnsub) { feedUnsub(); feedUnsub = null; }
    if (importedUnsub) { importedUnsub(); importedUnsub = null; }
    if (importedNotesUnsub) { importedNotesUnsub(); importedNotesUnsub = null; }
    publicUrls.set(new Set());
    importedUrls.set(new Set());
    importedNoteUrls.set(new Set());
    privateUrls.set(new Set());
    lastPrivateFetchPubkey = null;
    importedNotesDecryptPrivate = false;
    importedUrlsDecryptPrivate = false;
    if (!s.pubkey) return;
    // Public feed — same shape as /app/bookmarks' own subscription.
    // NDK dedups the relay request when both feeds are alive.
    const feed = createBookmarkFeed({ authors: [s.pubkey], limit: 500 });
    feedUnsub = feed.subscribe((bookmarks: ParsedBookmark[]) => {
      const next = new Set<string>();
      for (const b of bookmarks) if (b.url) next.add(b.url);
      publicUrls.set(next);
    });
    startImportedUrlsFeed(s.pubkey, latestCanSign);
    startImportedNotesFeed(s.pubkey, latestCanSign);
  });

  // Private set — needs a signer to decrypt. Re-runs once canSign
  // flips true, and again whenever the pubkey changes.
  const stopCanSign = canSign.subscribe((cs) => {
    latestCanSign = cs;
    if (cs && lastPubkey && !importedUrlsDecryptPrivate) {
      startImportedUrlsFeed(lastPubkey, true);
    }
    if (cs && lastPubkey && !importedNotesDecryptPrivate) {
      startImportedNotesFeed(lastPubkey, true);
    }
    if (!cs) return;
    const pubkey = lastPubkey;
    if (!pubkey || pubkey === lastPrivateFetchPubkey) return;
    lastPrivateFetchPubkey = pubkey;
    void fetchOwnPrivateSet(pubkey)
      .then((set) => {
        const next = new Set<string>();
        for (const entry of set.entries) {
          const url = entry.find((t) => t[0] === 'd')?.[1];
          if (url) next.add(url);
        }
        privateUrls.set(next);
      })
      .catch(() => {
        // Decrypt failure / relay miss — leave the private set empty;
        // worst case is a 'save' button on a URL the user already has
        // privately. Better than crashing the row.
      });
  });

  return () => {
    stopSession();
    stopCanSign();
    if (feedUnsub) { feedUnsub(); feedUnsub = null; }
    if (importedUnsub) { importedUnsub(); importedUnsub = null; }
    if (importedNotesUnsub) { importedNotesUnsub(); importedNotesUnsub = null; }
    started = false;
    lastPubkey = null;
    lastPrivateFetchPubkey = null;
    latestCanSign = false;
    importedNotesDecryptPrivate = false;
    importedUrlsDecryptPrivate = false;
  };
}

function startImportedUrlsFeed(pubkey: string, decryptPrivate: boolean): void {
  if (importedUnsub) { importedUnsub(); importedUnsub = null; }
  importedUrls.set(new Set());
  importedUrlsDecryptPrivate = decryptPrivate;
  // decryptPrivate so URLs that live only in an encrypted NIP-51 list
  // count as "already saved" — otherwise feed rows offer 'save' on a URL
  // the user privately bookmarked elsewhere. Re-runs once canSign flips.
  const imported = createImportedBookmarksFeed({ authors: [pubkey], limit: 500, decryptPrivate });
  importedUnsub = imported.subscribe((bookmarks) => {
    const next = new Set<string>();
    for (const b of bookmarks) if (b.url) next.add(b.url);
    importedUrls.set(next);
  });
}

function startImportedNotesFeed(pubkey: string, decryptPrivate: boolean): void {
  if (importedNotesUnsub) { importedNotesUnsub(); importedNotesUnsub = null; }
  importedNoteUrls.set(new Set());
  importedNotesDecryptPrivate = decryptPrivate;
  const importedNotes = createImportedNoteRefsFeed({ authors: [pubkey], limit: 500, decryptPrivate });
  importedNotesUnsub = importedNotes.subscribe((notes) => {
    const next = new Set<string>();
    for (const note of notes) {
      const url = nostrNoteArchiveUrl(note.targetEventId);
      if (url) next.add(url);
    }
    importedNoteUrls.set(next);
  });
}
