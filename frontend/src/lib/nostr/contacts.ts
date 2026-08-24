// NIP-02 contact list (kind:3) — the user's "following" graph.
//
// Tags shape: `["p", "<pubkey>", "<recommended-relay>", "<petname>"]`.
// Replaceable per-author event — the latest by created_at wins.
// Petnames + relay hints are optional; we only require the pubkey.
//
// Reactive store mirrors the mute-list module: a Svelte readable
// `followedPubkeys` lets feed.ts (or any future surface) react to
// follow/unfollow without per-page wiring. Loaded on session change
// from +layout.svelte.

import { writable, derived, type Readable } from 'svelte/store';
import { getNdk, hasConnectedRelays } from './ndk.js';
import { KIND } from './kinds.js';
import { publishEvent } from './publish.js';

export interface Contact {
  pubkey: string;
  relayUrl?: string;
  petname?: string;
}

export interface ContactList {
  contacts: Map<string, Contact>;
  /** Last-seen event id, for "have I loaded this yet" checks. */
  baseEventId?: string;
  /** Optional kind:3-style content (relay-list JSON for legacy clients).
   *  We preserve it on republish so we don't blow away another client's
   *  metadata. */
  content?: string;
  /** True only after a DEFINITIVE load (an event, or a connected relay
   *  answering "none exists"). Mutations refuse to republish otherwise —
   *  a fetch error used to leave the store empty() and follow() then
   *  replaced the user's whole kind:3 with a single p-tag (2026-08-23
   *  review #10, data loss). */
  loaded?: boolean;
}

const empty = (loaded = false): ContactList => ({ contacts: new Map(), loaded });

const internal = writable<ContactList>(empty());

export const contactList: Readable<ContactList> = { subscribe: internal.subscribe };

/** Convenience: just the followed-pubkeys set, for filter-style consumers. */
export const followedPubkeys: Readable<Set<string>> = derived(internal, ($c) =>
  new Set($c.contacts.keys()),
);

export async function loadContactList(ownerPubkey: string): Promise<void> {
  try {
    const ndk = getNdk();
    const event = await ndk.fetchEvent({
      kinds: [KIND.contacts],
      authors: [ownerPubkey],
    });
    if (!event) {
      // Null from a connected relay = genuinely no list (new account).
      // Null from a cold pool proves nothing — leave loaded false so
      // mutations refuse to republish emptiness over the real list.
      internal.set(empty(hasConnectedRelays()));
      return;
    }
    const parsed = parseContactEvent(event.tags as string[][]);
    parsed.baseEventId = event.id;
    parsed.content = event.content ?? '';
    parsed.loaded = true;
    internal.set(parsed);
  } catch {
    internal.set(empty(false));
  }
}

/** Pure parse — useful for tests + import flows. */
export function parseContactEvent(tags: string[][]): ContactList {
  const out = empty();
  for (const tag of tags) {
    const [name, pubkey, relayUrl, petname] = tag;
    if (name !== 'p') continue;
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) continue;
    out.contacts.set(pubkey, {
      pubkey,
      relayUrl: typeof relayUrl === 'string' && relayUrl ? relayUrl : undefined,
      petname: typeof petname === 'string' && petname ? petname : undefined,
    });
  }
  return out;
}

function listToTags(list: ContactList): string[][] {
  const tags: string[][] = [];
  for (const c of list.contacts.values()) {
    const row = ['p', c.pubkey];
    if (c.relayUrl) row.push(c.relayUrl);
    if (c.petname && !c.relayUrl) row.push('');
    if (c.petname) row.push(c.petname);
    tags.push(row);
  }
  return tags;
}

export async function follow(pubkey: string, ownerPubkey: string, opts: { relayUrl?: string; petname?: string } = {}): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  // Fetch first so we don't clobber a recent edit from another client.
  await loadContactList(ownerPubkey);
  assertContactsLoaded();
  internal.update((list) => {
    list.contacts.set(pubkey, { pubkey, ...opts });
    return list;
  });
  await republish(ownerPubkey);
}

export async function unfollow(pubkey: string, ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  await loadContactList(ownerPubkey);
  assertContactsLoaded();
  internal.update((list) => {
    list.contacts.delete(pubkey);
    return list;
  });
  await republish(ownerPubkey);
}

function assertContactsLoaded(): void {
  let loaded = false;
  internal.subscribe((v) => { loaded = v.loaded === true; })();
  if (!loaded) {
    throw new Error('contact list could not be loaded — not publishing over it; try again in a moment');
  }
}

async function republish(ownerPubkey: string): Promise<void> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer connected');
  let snapshot: ContactList = empty();
  internal.subscribe((v) => { snapshot = v; })();
  await publishEvent({
    kind: KIND.contacts,
    created_at: Math.floor(Date.now() / 1000),
    tags: listToTags(snapshot),
    // Preserve any content (relay-list JSON some clients still write
    // here) we read on the way in.
    content: snapshot.content ?? '',
  }, ownerPubkey);
}
