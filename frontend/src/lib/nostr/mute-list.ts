// NIP-51 mute list (kind:10000) — pubkeys, hashtags, and words the
// signed-in user wants hidden from feeds.
//
// We handle the PUBLIC mute path only: tags on the kind:10000 event
// itself, visible to anyone reading the relay. NIP-51 also supports a
// PRIVATE encrypted content payload for mutes the user wants kept
// secret; not implemented here yet — mute operations should already
// be a public statement of "I don't want to see this person."
//
// Reactive store: `mutedPubkeys` is a Svelte readable<Set<string>>
// that the feed module subscribes to so muting takes effect across
// every list view (recent, network, search results, /app/url/, etc.)
// without per-list plumbing.

import { writable, derived, type Readable } from 'svelte/store';
import { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';

export interface MuteList {
  pubkeys: Set<string>;
  hashtags: Set<string>;
  words: Set<string>;
  /** Last-seen event id, for "have I loaded this yet" checks. */
  baseEventId?: string;
}

const empty = (): MuteList => ({
  pubkeys: new Set(),
  hashtags: new Set(),
  words: new Set(),
});

const internal = writable<MuteList>(empty());

/** The user's mute list, kept fresh by `loadMuteList` and the
 *  edit helpers below. Subscribe to filter UI elements. */
export const muteList: Readable<MuteList> = { subscribe: internal.subscribe };

/** Convenience: just the muted-pubkeys set. Most consumers only need
 *  this — feed.ts subscribes to drop matching curators. */
export const mutedPubkeys: Readable<Set<string>> = derived(internal, ($m) => $m.pubkeys);

/**
 * Fetch the user's kind:10000 from their relays and populate the
 * store. Idempotent — call on session change or after a publish.
 * Failures are silent: a relay hiccup shouldn't crash the page, and
 * an empty result is the legitimate state for a brand-new account.
 */
export async function loadMuteList(ownerPubkey: string): Promise<void> {
  try {
    const ndk = getNdk();
    const event = await ndk.fetchEvent({
      kinds: [KIND.muteList],
      authors: [ownerPubkey],
    });
    if (!event) {
      internal.set(empty());
      return;
    }
    const parsed = parseMuteListEvent(event.tags as string[][]);
    parsed.baseEventId = event.id;
    internal.set(parsed);
  } catch {
    // Already-published mute list will re-load on next session start.
    internal.set(empty());
  }
}

/** Pure parse — handy for tests + import flows. */
export function parseMuteListEvent(tags: string[][]): MuteList {
  const out = empty();
  for (const tag of tags) {
    const [name, value] = tag;
    if (typeof value !== 'string' || !value) continue;
    switch (name) {
      case 'p': out.pubkeys.add(value); break;
      case 't': out.hashtags.add(value.toLowerCase()); break;
      case 'word': out.words.add(value.toLowerCase()); break;
      // Other tag types (e for thread mutes) are valid but we don't
      // surface them in the bookmark feed.
    }
  }
  return out;
}

function muteListToTags(list: MuteList): string[][] {
  const tags: string[][] = [];
  for (const p of list.pubkeys) tags.push(['p', p]);
  for (const t of list.hashtags) tags.push(['t', t]);
  for (const w of list.words) tags.push(['word', w]);
  return tags;
}

/** Add a pubkey to the mute list and republish. Optimistic — updates
 *  the local store before the relay round-trip so the feed
 *  re-filters immediately. */
export async function mutePubkey(pubkey: string, ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  let next: MuteList;
  internal.update((curr) => {
    next = {
      ...curr,
      pubkeys: new Set([...curr.pubkeys, pubkey]),
    };
    return next;
  });
  // Refetch first so we don't clobber a recent edit from another
  // device. Then merge our addition + republish.
  await loadMuteList(ownerPubkey);
  internal.update((latest) => ({
    ...latest,
    pubkeys: new Set([...latest.pubkeys, pubkey, ...next.pubkeys]),
  }));
  await republish(ownerPubkey);
}

/** Remove a pubkey from the mute list and republish. */
export async function unmutePubkey(pubkey: string, ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  await loadMuteList(ownerPubkey);
  internal.update((latest) => {
    const pubkeys = new Set(latest.pubkeys);
    pubkeys.delete(pubkey);
    return { ...latest, pubkeys };
  });
  await republish(ownerPubkey);
}

async function republish(ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  let snapshot: MuteList = empty();
  internal.subscribe((v) => { snapshot = v; })();
  const ev = new NDKEvent(ndk, {
    kind: KIND.muteList,
    pubkey: ownerPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: muteListToTags(snapshot),
    content: '',
  });
  await ev.publish();
}
