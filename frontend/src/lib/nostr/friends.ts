// Deepmarks friends are a NIP-51 categorized follow set:
//
//   kind:30000, d=deepmarks-friends, p-tags for selected pubkeys
//
// This deliberately does not replace the user's NIP-02 contact list.
// The NIP-02 list remains the portable "following" graph; this set is
// a standard NIP-51 subset the app uses for the friends bookmark feed.

import { derived, writable, type Readable } from 'svelte/store';
import { canonicalRelaySet } from './canonical-relay-set.js';
import { getNdk, hasConnectedRelays } from './ndk.js';
import { KIND } from './kinds.js';
import { publishEvent } from './publish.js';

export const FRIENDS_SET_NAME = 'deepmarks-friends';

export interface FriendsList {
  pubkeys: Set<string>;
  baseEventId?: string;
  loaded: boolean;
}

const empty = (loaded = false): FriendsList => ({
  pubkeys: new Set(),
  loaded,
});

const internal = writable<FriendsList>(empty());

export const friendsList: Readable<FriendsList> = { subscribe: internal.subscribe };
export const friendPubkeys: Readable<Set<string>> = derived(internal, ($list) =>
  new Set($list.pubkeys),
);

export async function loadFriendsList(ownerPubkey: string): Promise<void> {
  const owner = ownerPubkey.toLowerCase();
  try {
    const ndk = getNdk();
    const relaySet = canonicalRelaySet();
    const event = await ndk.fetchEvent(
      {
        kinds: [KIND.followSet],
        authors: [owner],
        '#d': [FRIENDS_SET_NAME],
      },
      relaySet ? { groupable: false } : undefined,
      relaySet ?? undefined,
    );
    if (!event || event.pubkey.toLowerCase() !== owner) {
      // Only a CONNECTED relay answering "no event" proves the list is
      // genuinely empty; a cold-pool null proves nothing (2026-08-23
      // review #10 — the loaded flag exists so mutations don't republish
      // emptiness over the real list).
      internal.set(empty(hasConnectedRelays()));
      return;
    }
    const parsed = parseFriendsSetEvent(event.tags as string[][]);
    parsed.baseEventId = event.id;
    parsed.loaded = true;
    internal.set(parsed);
  } catch {
    // A fetch ERROR used to set empty(true) — marking a failed load as
    // definitive, so addFriend() republished a near-empty follow set
    // over the user's real one (2026-08-23 review #10, data loss).
    internal.set(empty(false));
  }
}

export function parseFriendsSetEvent(tags: string[][]): FriendsList {
  const out = empty(true);
  for (const tag of tags) {
    const [name, pubkey] = tag;
    if (name !== 'p') continue;
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) continue;
    out.pubkeys.add(pubkey.toLowerCase());
  }
  return out;
}

export async function setFriends(pubkeys: Iterable<string>, ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  const owner = ownerPubkey.toLowerCase();
  const clean = new Set(
    [...pubkeys]
      .map((p) => p.toLowerCase())
      .filter((p) => /^[0-9a-f]{64}$/.test(p) && p !== owner),
  );
  internal.update((current) => ({ ...current, pubkeys: clean, loaded: true }));
  await republish(ownerPubkey);
}

export async function addFriend(pubkey: string, ownerPubkey: string): Promise<void> {
  const latest = await latestFriends(ownerPubkey);
  latest.add(pubkey.toLowerCase());
  latest.delete(ownerPubkey.toLowerCase());
  await setFriends(latest, ownerPubkey);
}

export async function removeFriend(pubkey: string, ownerPubkey: string): Promise<void> {
  const latest = await latestFriends(ownerPubkey);
  latest.delete(pubkey.toLowerCase());
  await setFriends(latest, ownerPubkey);
}

async function latestFriends(ownerPubkey: string): Promise<Set<string>> {
  await loadFriendsList(ownerPubkey);
  let state: FriendsList = empty();
  internal.subscribe((value) => { state = value; })();
  if (!state.loaded) {
    throw new Error('friends list could not be loaded — not publishing over it; try again in a moment');
  }
  return new Set(state.pubkeys);
}

async function republish(ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  let snapshot: FriendsList = empty(true);
  internal.subscribe((value) => { snapshot = value; })();
  const tags: string[][] = [
    ['d', FRIENDS_SET_NAME],
    ['title', 'Deepmarks friends'],
  ];
  for (const pubkey of [...snapshot.pubkeys].sort()) {
    tags.push(['p', pubkey]);
  }
  await publishEvent({
    kind: KIND.followSet,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, ownerPubkey, { failureSubject: 'friends list' });
}
