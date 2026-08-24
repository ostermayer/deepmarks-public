// private-set-core.ts — the pure, dependency-free heart of the encrypted
// private-bookmark set: chunk naming, complete-version selection, per-item
// events, and the tombstone-aware merge.
//
// ⚠ BYTE-IDENTICAL COPIES of this file live in BOTH trees:
//     frontend/src/lib/nostr/private-set-core.ts
//     browser-extension/src/lib/private-set-core.ts
// tests/frontend/regression/shared-core-parity.test.ts fails the build if
// they drift. This logic drifting between surfaces is exactly what caused
// the 2026-06 private-library wipe bug — edit both copies together.
//
// No imports: everything here is platform-neutral (WebCrypto's
// crypto.subtle exists in browsers, workers, and node ≥ 20).

export const PRIVATE_SET_NAME = 'deepmarks-private';
export const PRIVATE_SET_CHUNK_PREFIX = `${PRIVATE_SET_NAME}-`;
export const PRIVATE_SET_ITEM_PREFIX = `${PRIVATE_SET_NAME}-item:`;
export const PRIVATE_SET_VERSION_TAG = 'dm-set-version';
export const PRIVATE_SET_COUNT_TAG = 'dm-set-count';
export const MAX_PRIVATE_SET_PLAINTEXT_BYTES = 60_000;

/** Minimum event shape the selectors need — NDKEvent, nostr-tools events,
 *  and our SignedEventLike all satisfy it. */
export interface PrivateSetEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface DecryptedPrivateSetEventCore {
  id: string;
  createdAt: number;
  tags: string[][];
  entries: string[][][];
}

export interface MergedPrivateSetCore {
  entries: string[][][];
  baseEventId?: string;
  createdAt?: number;
  savedAt?: number;
  chunkNames: string[];
  /** URL → created_at of the newest delete tombstone seen for it. */
  deletedUrls: Record<string, number>;
}

export function privateSetDTag(tags: string[][]): string | undefined {
  return tags.find((t) => t[0] === 'd')?.[1];
}

export function privateSetTagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

export function privateEntryUrl(entry: string[][]): string | undefined {
  return entry.find((t) => t[0] === 'd')?.[1];
}

export function privateSetNameForIndex(index: number): string {
  return index === 0 ? PRIVATE_SET_NAME : `${PRIVATE_SET_CHUNK_PREFIX}${index}`;
}

export function privateSetIndexFromName(name: string | undefined): number | null {
  if (name === PRIVATE_SET_NAME) return 0;
  if (!name?.startsWith(PRIVATE_SET_CHUNK_PREFIX)) return null;
  const raw = name.slice(PRIVATE_SET_CHUNK_PREFIX.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return Number(raw);
}

export function isPrivateItemSetName(name: string | undefined): boolean {
  return !!name?.startsWith(PRIVATE_SET_ITEM_PREFIX);
}

export async function privateItemSetNameForUrl(url: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${PRIVATE_SET_ITEM_PREFIX}${hex}`;
}

/**
 * Validate the decrypted-JSON shape — array of arrays of string arrays —
 * so the downstream `string[][][]` cast is actually safe.
 */
export function isValidEntriesShape(value: unknown): value is string[][][] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.every(
        (tag) => Array.isArray(tag) && tag.every((cell) => typeof cell === 'string'),
      ),
  );
}

function encodedJsonBytes(entries: string[][][]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}

export function chunkPrivateSetEntries(
  entries: string[][][],
  maxBytes = MAX_PRIVATE_SET_PLAINTEXT_BYTES,
): string[][][][] {
  if (entries.length === 0) return [[]];
  const chunks: string[][][][] = [];
  let current: string[][][] = [];
  for (const entry of entries) {
    const next = [...current, entry];
    if (current.length > 0 && encodedJsonBytes(next) > maxBytes) {
      chunks.push(current);
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function newPrivateSetVersion(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Pick the newest COMPLETE chunk generation: a primary (chunk 0) whose
 * dm-set-version group has every index present. Falls back to the legacy
 * un-versioned layout, then to a last-resort union of the latest event per
 * chunk index across versions — recovering data when chunks are split
 * between an in-progress new version and an older one (the "bookmarks
 * vanished" gap seen in the wild).
 */
export function selectCompletePrivateSetEvents<T extends PrivateSetEventLike>(events: T[]): T[] {
  const records = events
    .map((event) => ({
      event,
      index: privateSetIndexFromName(privateSetDTag(event.tags)),
      version: privateSetTagValue(event.tags, PRIVATE_SET_VERSION_TAG),
      count: Number(privateSetTagValue(event.tags, PRIVATE_SET_COUNT_TAG)),
    }))
    .filter((record): record is {
      event: T;
      index: number;
      version: string | undefined;
      count: number;
    } => record.index !== null);

  const primaries = records
    .filter((record) => record.index === 0)
    .sort((a, b) => b.event.created_at - a.event.created_at);

  for (const primary of primaries) {
    if (primary.version && Number.isInteger(primary.count) && primary.count > 0) {
      const group = new Map<number, T>();
      for (const record of records) {
        if (record.version !== primary.version) continue;
        if (record.index < 0 || record.index >= primary.count) continue;
        const current = group.get(record.index);
        if (!current || record.event.created_at > current.created_at) group.set(record.index, record.event);
      }
      if (group.size === primary.count) {
        return Array.from(group.entries())
          .sort(([a], [b]) => a - b)
          .map(([, event]) => event);
      }
      continue;
    }

    const latestLegacyByIndex = new Map<number, T>();
    for (const record of records) {
      if (record.version) continue;
      const current = latestLegacyByIndex.get(record.index);
      if (!current || record.event.created_at > current.created_at) {
        latestLegacyByIndex.set(record.index, record.event);
      }
    }
    if (latestLegacyByIndex.size > 0) {
      return Array.from(latestLegacyByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([, event]) => event);
    }
  }

  if (records.length === 0) return [];
  const unionByIndex = new Map<number, T>();
  for (const record of records) {
    if (record.index < 0) continue;
    const current = unionByIndex.get(record.index);
    if (!current || record.event.created_at > current.created_at) {
      unionByIndex.set(record.index, record.event);
    }
  }
  return Array.from(unionByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, event]) => event);
}

export function selectLatestPrivateItemEvents<T extends PrivateSetEventLike>(events: T[]): T[] {
  const latestByName = new Map<string, T>();
  for (const event of events) {
    const name = privateSetDTag(event.tags);
    if (!name || !isPrivateItemSetName(name)) continue;
    const current = latestByName.get(name);
    if (!current || event.created_at > current.created_at) latestByName.set(name, event);
  }
  return [...latestByName.values()].sort((a, b) => a.created_at - b.created_at);
}

export function selectPrivateBookmarkSetEvents<T extends PrivateSetEventLike>(events: T[]): T[] {
  return [
    ...selectCompletePrivateSetEvents(events),
    ...selectLatestPrivateItemEvents(events),
  ];
}

/**
 * Tombstone-aware merge of decrypted set events (chunks + per-item events,
 * in selectPrivateBookmarkSetEvents order). Newest record per URL wins;
 * a `deleted:1` entry at least as new as a bookmark entry removes it and
 * is reported in `deletedUrls` so store merges and cache unions can drop
 * copies another device deleted.
 */
export function mergePrivateSetEventEntries(events: DecryptedPrivateSetEventCore[]): MergedPrivateSetCore {
  const byUrl = new Map<string, { entry: string[][]; createdAt: number; order: number }>();
  const deletedByUrl = new Map<string, number>();
  const anonymous: string[][][] = [];
  const chunkNames: string[] = [];
  let savedAt = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const name = privateSetDTag(event.tags);
    if (privateSetIndexFromName(name) !== null) chunkNames.push(name!);
    for (const entry of event.entries) {
      const url = privateEntryUrl(entry);
      if (!url) {
        anonymous.push(entry);
        continue;
      }
      if (entry.some((t) => t[0] === 'deleted' && t[1] === '1')) {
        const currentDeletedAt = deletedByUrl.get(url);
        if (currentDeletedAt === undefined || event.createdAt >= currentDeletedAt) {
          deletedByUrl.set(url, event.createdAt);
        }
        const currentEntry = byUrl.get(url);
        if (currentEntry && event.createdAt >= currentEntry.createdAt) byUrl.delete(url);
        continue;
      }
      const currentDeletedAt = deletedByUrl.get(url);
      if (currentDeletedAt !== undefined && currentDeletedAt >= event.createdAt) continue;
      const current = byUrl.get(url);
      if (!current || event.createdAt >= current.createdAt) {
        byUrl.set(url, { entry, createdAt: event.createdAt, order: i });
      }
    }
    savedAt = Math.max(savedAt, event.createdAt);
  }
  const entries = [
    ...anonymous,
    ...[...byUrl.values()]
      .sort((a, b) => a.order - b.order)
      .map((record) => record.entry),
  ];
  return {
    entries,
    baseEventId: events[0]?.id,
    createdAt: events[0]?.createdAt,
    savedAt: savedAt || undefined,
    chunkNames,
    deletedUrls: Object.fromEntries(deletedByUrl),
  };
}
