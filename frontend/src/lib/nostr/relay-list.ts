// NIP-65 (kind:10002) relay-list loader.
//
// Every user publishes a replaceable kind:10002 listing their preferred
// read + write relays. NDK's outbox model uses these automatically for
// routing, but our settings page needs to *display* the resolved list
// so the user can see Deepmarks actually picked it up.
//
// Pure fetch + parse, cached like profiles.ts. One request per pubkey
// per session; localStorage survives across reloads.

import { readable, type Readable } from 'svelte/store';
import { getNdk } from './ndk.js';

export interface RelayEntry {
  url: string;
  /** 'read' — NIP-65 marked this relay read-only for the user.
   *  'write' — write-only.
   *  'both' — no marker (NIP-65 default = both). */
  mode: 'read' | 'write' | 'both';
}

export interface RelayList {
  pubkey: string;
  relays: RelayEntry[];
  /** Unix seconds the event was signed — lets the UI flag a stale list. */
  at: number;
}

const RELAY_LIST_LS_PREFIX = 'deepmarks-relay-list:v1:';

interface CacheEntry {
  store: RelayListStore;
  promise: Promise<void>;
}
interface RelayListStore extends Readable<RelayList | null> {
  __set(r: RelayList | null): void;
}

const cache = new Map<string, CacheEntry>();

function parseRelayList(event: { pubkey: string; tags: string[][]; created_at: number }): RelayList {
  const relays: RelayEntry[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'r' || typeof t[1] !== 'string') continue;
    const url = t[1].trim();
    if (!/^wss?:\/\//i.test(url)) continue;
    const marker = typeof t[2] === 'string' ? t[2].toLowerCase() : '';
    const mode: RelayEntry['mode'] =
      marker === 'read' ? 'read' : marker === 'write' ? 'write' : 'both';
    relays.push({ url, mode });
  }
  return { pubkey: event.pubkey, relays, at: event.created_at };
}

function loadPersisted(pubkey: string): RelayList | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RELAY_LIST_LS_PREFIX + pubkey);
    return raw ? (JSON.parse(raw) as RelayList) : null;
  } catch {
    return null;
  }
}

function savePersisted(pubkey: string, list: RelayList | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (list) localStorage.setItem(RELAY_LIST_LS_PREFIX + pubkey, JSON.stringify(list));
  } catch {
    /* quota — tolerable */
  }
}

function createStore(): RelayListStore {
  let current: RelayList | null = null;
  const subs = new Set<(v: RelayList | null) => void>();
  return {
    subscribe(run) {
      subs.add(run);
      run(current);
      return () => subs.delete(run);
    },
    __set(v) {
      current = v;
      for (const fn of subs) fn(current);
    },
  };
}

/** Reactive store for the user's NIP-65 relay list. Returns null until
 *  resolved; stays null if the user has never published one. */
export function getRelayList(pubkey: string): Readable<RelayList | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return readable(null);
  const hit = cache.get(pubkey);
  if (hit) return hit.store;

  const store = createStore();
  const persisted = loadPersisted(pubkey);
  if (persisted) store.__set(persisted);

  const promise = (async () => {
    const ndk = getNdk();
    const event = await ndk.fetchEvent({ kinds: [10002], authors: [pubkey] });
    if (!event) return;
    const parsed = parseRelayList({
      pubkey: event.pubkey,
      tags: event.tags,
      // NDKEvent.created_at is typed optional even though it's always
      // set on received events; fall back to 0 so parseRelayList's
      // strict number contract is satisfied.
      created_at: event.created_at ?? 0,
    });
    store.__set(parsed);
    savePersisted(pubkey, parsed);
  })().catch(() => {
    // Fetch failed or user has no kind:10002 — store stays at the
    // seeded or null value.
  });

  cache.set(pubkey, { store, promise });
  return store;
}

export { parseRelayList };
