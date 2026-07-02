import type { Redis } from 'ioredis';
import type { SimplePool, Event as NostrEvent } from 'nostr-tools';
import { normalizeRelayUrl, queryWithTimeout } from './relay-helpers.js';
import { extractNostrEventRefFromUrl } from './nostr-social-refs.js';

export const BOOKMARKED_NOTE_TARGET_PREFIX = 'dm:bookmarked-note-target:';
export const BOOKMARKED_NOTE_TARGET_TTL_S = 30 * 24 * 60 * 60;

export const SOCIAL_BOOKMARK_DISCOVERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://nostr.land',
] as const;

export interface BookmarkedNoteTargets {
  ids: string[];
  idSet: Set<string>;
  relays: string[];
}

export function collectBookmarkedNoteTargets(events: NostrEvent[]): BookmarkedNoteTargets {
  const idSet = new Set<string>();
  const relaySet = new Set<string>();
  for (const event of events) {
    if (event.kind === 39701) {
      const url = event.tags.find((tag) => tag[0] === 'd')?.[1];
      if (typeof url === 'string') addEventRef(url, idSet, relaySet);
      continue;
    }
    if (event.kind !== 10003 && event.kind !== 30003 && event.kind !== 30001) continue;
    collectBookmarkedNoteTargetsFromTags(event.tags, idSet, relaySet);
  }
  return {
    ids: Array.from(idSet),
    idSet,
    relays: Array.from(relaySet),
  };
}

export function collectBookmarkedNoteTargetsFromTags(
  tags: string[][],
  idSet = new Set<string>(),
  relaySet = new Set<string>(),
): BookmarkedNoteTargets {
  for (const tag of tags) {
    if (tag[0] === 'e') {
      const id = tag[1]?.toLowerCase();
      if (id && /^[0-9a-f]{64}$/.test(id)) idSet.add(id);
      const relay = typeof tag[2] === 'string' ? normalizeRelayUrl(tag[2]) : null;
      if (relay) relaySet.add(relay);
    } else if (tag[0] === 'r' && typeof tag[1] === 'string') {
      addEventRef(tag[1], idSet, relaySet);
    }
  }
  return {
    ids: Array.from(idSet),
    idSet,
    relays: Array.from(relaySet),
  };
}

export async function allowBookmarkedNoteTargets(
  redis: Redis,
  eventIds: string[],
): Promise<string[]> {
  const ids = normalizeEventIds(eventIds);
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) {
    pipeline.set(BOOKMARKED_NOTE_TARGET_PREFIX + id, '1', 'EX', BOOKMARKED_NOTE_TARGET_TTL_S);
  }
  await pipeline.exec().catch(() => undefined);
  return ids;
}

export async function fetchBookmarkedKind1Targets(
  pool: SimplePool,
  relays: string[],
  targetIds: string[],
  opts: {
    timeoutMs: number;
    maxTargets: number;
    maxRelays: number;
    batchSize?: number;
  },
): Promise<NostrEvent[]> {
  const ids = normalizeEventIds(targetIds).slice(0, opts.maxTargets);
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const queryRelays = normalizeRelayList(relays).slice(0, opts.maxRelays);
  if (queryRelays.length === 0) return [];

  const events: NostrEvent[] = [];
  const batchSize = opts.batchSize ?? 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    events.push(...await queryWithTimeout(
      pool,
      queryRelays,
      { ids: batch, kinds: [1], limit: batch.length },
      opts.timeoutMs,
    ));
  }

  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== 1) continue;
    const id = event.id.toLowerCase();
    if (!idSet.has(id)) continue;
    byId.set(id, event);
  }
  return Array.from(byId.values());
}

export function normalizeEventIds(eventIds: string[]): string[] {
  return Array.from(new Set(
    eventIds
      .map((id) => id.toLowerCase())
      .filter((id) => /^[0-9a-f]{64}$/.test(id)),
  ));
}

export function normalizeRelayList(relays: string[]): string[] {
  return Array.from(new Set(
    relays
      .map((relay) => normalizeRelayUrl(relay))
      .filter((relay): relay is string => !!relay),
  ));
}

function addEventRef(input: string, idSet: Set<string>, relaySet: Set<string>): void {
  const ref = extractNostrEventRefFromUrl(input);
  if (!ref) return;
  idSet.add(ref.id);
  for (const relay of ref.relays) relaySet.add(relay);
}
