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

import { readable, type Readable } from 'svelte/store';
import type { NDKEvent } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import type { SignedEventLike } from './bookmarks.js';

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
}

const cache = new Map<string, CacheEntry>();

function loadPersisted(id: string): ResolvedEvent | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(EVENT_CACHE_LS_PREFIX + id);
    return raw ? (JSON.parse(raw) as ResolvedEvent) : null;
  } catch {
    return null;
  }
}

function savePersisted(id: string, event: ResolvedEvent | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (event) localStorage.setItem(EVENT_CACHE_LS_PREFIX + id, JSON.stringify(event));
  } catch {
    // Quota / private browsing — tolerable.
  }
}

/** Lookup + subscribe. Returns a reactive store that resolves to the
 *  target event or null (if no relay has it). */
export function resolveEvent(id: string): Readable<ResolvedEvent | null> {
  if (!id || !/^[0-9a-f]{64}$/i.test(id)) {
    return readable(null);
  }
  const hit = cache.get(id);
  if (hit) return hit.store;

  const store = createEventStore(id);
  const persisted = loadPersisted(id);
  if (persisted) store.__set(persisted);

  const promise = fetchAndPopulate(id, store).catch(() => {
    // Event not found on any relay — store resolves to null.
  });
  cache.set(id, { store, promise });
  return store;
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
    },
  };
}

async function fetchAndPopulate(id: string, store: EventStore): Promise<void> {
  const ndk = getNdk();
  const event = await ndk.fetchEvent({ ids: [id] });
  if (!event) return;
  const resolved = toResolved(event as unknown as SignedEventLike);
  store.__set(resolved);
  savePersisted(id, resolved);
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
}
