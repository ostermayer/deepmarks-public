// Fetch-once-and-cache for Nostr events referenced by id.
//
// Used by NoteCard / ArticleCard to resolve the target of an `e` tag
// (kind:10003 / 30003 bookmark list entries) into a full event we can
// render. Without deduping, a profile with 50 note-bookmarks would fire
// 50 independent REQs at the relay pool on first paint; with this cache
// each event id is requested at most once per session and paints
// instantly on subsequent references.
//
// Structure mirrors profiles.ts: in-memory Map<id, store> for session
// dedup + localStorage for warm-boot so cold loads hydrate with the
// last-seen content rather than flashing a placeholder.

import { get, readable, writable, type Readable } from 'svelte/store';
import type { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { ndkEventAsSigned, type SignedEventLike } from './bookmarks.js';

/** Resolved event shape — we only carry what the cards actually need
 *  so the JSON we persist stays small. */
export interface ResolvedEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

const EVENT_CACHE_LS_PREFIX = 'deepmarks-event-cache:v1:';

interface CacheEntry {
  store: EventStore;
  promise: Promise<void>;
  /** True while a relay fetch for this id is running — prevents stacked
   *  refetches when many cards reference the same unresolved id. */
  inFlight: boolean;
}

const cache = new Map<string, CacheEntry>();
const persistedPeekCache = new Map<string, ResolvedEvent | null>();
export const resolvedEventsVersion = writable(0);

function loadPersisted(id: string): ResolvedEvent | null {
  if (persistedPeekCache.has(id)) return persistedPeekCache.get(id) ?? null;
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(EVENT_CACHE_LS_PREFIX + id);
    const parsed = raw ? (JSON.parse(raw) as ResolvedEvent) : null;
    persistedPeekCache.set(id, parsed);
    return parsed;
  } catch {
    persistedPeekCache.set(id, null);
    return null;
  }
}

function savePersisted(id: string, event: ResolvedEvent | null): void {
  persistedPeekCache.set(id, event);
  if (typeof localStorage === 'undefined') return;
  try {
    if (event) localStorage.setItem(EVENT_CACHE_LS_PREFIX + id, JSON.stringify(event));
  } catch {
    // Quota / private browsing — tolerable.
  }
}

export function peekResolvedEvent(id: string): ResolvedEvent | null {
  if (!id || !/^[0-9a-f]{64}$/i.test(id)) return null;
  const hit = cache.get(id);
  if (hit) return get(hit.store);
  return loadPersisted(id);
}

/** Lookup + subscribe. Returns a reactive store that resolves to the
 *  target event or null (if no relay has it). */
export function resolveEvent(id: string): Readable<ResolvedEvent | null> {
  if (!id || !/^[0-9a-f]{64}$/i.test(id)) {
    return readable(null);
  }
  const hit = cache.get(id);
  if (hit) {
    // A previous lookup missed (store still null). The target may have
    // been mirrored to the relay since — e.g. a bookmarked note whose
    // kind:1 the server pulls in asynchronously — so a fresh resolve
    // call retries instead of pinning the miss for the whole session.
    if (!hit.inFlight && get(hit.store) === null) {
      hit.inFlight = true;
      hit.promise = fetchAndPopulate(id, hit.store)
        .catch(() => { /* still missing — store stays null */ })
        .finally(() => { hit.inFlight = false; });
    }
    return hit.store;
  }

  const store = createEventStore(id);
  const persisted = loadPersisted(id);
  if (persisted) store.__set(persisted);

  const entry: CacheEntry = { store, promise: Promise.resolve(), inFlight: true };
  entry.promise = fetchAndPopulate(id, store)
    .catch(() => {
      // Event not found on any relay — store resolves to null.
    })
    .finally(() => { entry.inFlight = false; });
  cache.set(id, entry);
  return store;
}

/** Batch-hydrate event ids into the same cache NoteCard reads from.
 * Friends feeds can prime visible NIP-51 note targets once per page,
 * instead of letting every row fire an isolated relay query. */
export async function primeEvents(ids: Iterable<string>): Promise<void> {
  const targets = Array.from(new Set(
    [...ids]
      .map((id) => id.toLowerCase())
      .filter((id) => /^[0-9a-f]{64}$/.test(id)),
  ));
  if (targets.length === 0) return;

  const missing: Array<{ id: string; store: EventStore }> = [];
  for (const id of targets) {
    const hit = cache.get(id);
    if (hit) {
      if (get(hit.store)) continue;
      missing.push({ id, store: hit.store });
      continue;
    }
    const store = createEventStore(id);
    const persisted = loadPersisted(id);
    if (persisted) {
      store.__set(persisted);
      cache.set(id, { store, promise: Promise.resolve(), inFlight: false });
      continue;
    }
    missing.push({ id, store });
  }
  if (missing.length === 0) return;

  const batchEntries: CacheEntry[] = [];
  const fetchPromise = fetchBatchAndPopulate(missing)
    .catch(() => {
      // Keep stores at null; individual resolveEvent calls can retry later.
    })
    .finally(() => {
      for (const entry of batchEntries) entry.inFlight = false;
    });
  for (const entry of missing) {
    const cacheEntry: CacheEntry = { store: entry.store, promise: fetchPromise, inFlight: true };
    batchEntries.push(cacheEntry);
    cache.set(entry.id, cacheEntry);
  }
  await fetchPromise;
}

interface EventStore extends Readable<ResolvedEvent | null> {
  __set(e: ResolvedEvent | null): void;
}

function createEventStore(_id: string): EventStore {
  let current: ResolvedEvent | null = null;
  const subs = new Set<(value: ResolvedEvent | null) => void>();
  return {
    subscribe(run) {
      subs.add(run);
      run(current);
      return () => subs.delete(run);
    },
    __set(e) {
      current = e;
      for (const fn of subs) fn(current);
      resolvedEventsVersion.update((n) => n + 1);
    },
  };
}

async function fetchAndPopulate(id: string, store: EventStore): Promise<void> {
  const ndk = getNdk();
  const event = await ndk.fetchEvent({ ids: [id] });
  if (!event) return;
  const resolved = toResolved(ndkEventAsSigned(event));
  store.__set(resolved);
  savePersisted(id, resolved);
}

async function fetchBatchAndPopulate(entries: Array<{ id: string; store: EventStore }>): Promise<void> {
  const ndk = getNdk();
  const byId = new Map(entries.map((entry) => [entry.id, entry.store]));
  const batchSize = 50;
  for (let i = 0; i < entries.length; i += batchSize) {
    const ids = entries.slice(i, i + batchSize).map((entry) => entry.id);
    const events = Array.from(await ndk.fetchEvents({ ids }));
    for (const event of events) {
      const resolved = toResolved(ndkEventAsSigned(event));
      const store = byId.get(resolved.id);
      if (!store) continue;
      store.__set(resolved);
      savePersisted(resolved.id, resolved);
    }
  }
}

function toResolved(event: SignedEventLike): ResolvedEvent {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags,
    content: event.content,
  };
}

/** Test hook — drop the cache between runs. */
export function __resetEventCacheForTests(): void {
  cache.clear();
  persistedPeekCache.clear();
  resolvedEventsVersion.set(0);
}
