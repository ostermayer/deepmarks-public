import type { Event as NostrEvent } from 'nostr-tools';
import { buildNip98AuthHeader } from './nip98.js';

const API_BASE = 'https://api.deepmarks.org';
const DEEPMARKS_RELAY = 'wss://relay.deepmarks.org';
const STORAGE_PREFIX = 'deepmarks-pending-publish:';
const MAX_ATTEMPTS = 30;
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;
const DRAIN_CONCURRENCY = 4;

export interface PendingPublishItem {
  pubkey: string;
  event: NostrEvent;
  key: string;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}

export interface DrainResult {
  attempted: number;
  ok: number;
  failed: number;
  remaining: number;
}

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}${pubkey}`;
}

function eventKey(event: NostrEvent): string {
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
  if (d) return `${event.pubkey}:k${event.kind}:d=${d}`;
  if (event.kind === 5) {
    const targets = event.tags
      .filter((tag) => tag[0] === 'e' || tag[0] === 'a' || tag[0] === 'k')
      .map((tag) => tag.join('='))
      .sort()
      .join('|');
    return `${event.pubkey}:k5:${event.created_at}:${targets}`;
  }
  return `${event.pubkey}:id=${event.id}`;
}

function isPendingItem(value: unknown): value is PendingPublishItem {
  const item = value as PendingPublishItem | undefined;
  return !!item &&
    typeof item.pubkey === 'string' &&
    typeof item.key === 'string' &&
    typeof item.enqueuedAt === 'number' &&
    typeof item.attempts === 'number' &&
    !!item.event &&
    typeof item.event === 'object' &&
    typeof item.event.id === 'string' &&
    typeof item.event.pubkey === 'string' &&
    typeof item.event.kind === 'number' &&
    Array.isArray(item.event.tags);
}

async function readQueue(pubkey: string): Promise<PendingPublishItem[]> {
  try {
    const raw = await chrome.storage.local.get(storageKey(pubkey));
    const parsed = raw[storageKey(pubkey)];
    return Array.isArray(parsed) ? parsed.filter(isPendingItem) : [];
  } catch {
    return [];
  }
}

async function writeQueue(pubkey: string, items: PendingPublishItem[]): Promise<boolean> {
  try {
    if (items.length === 0) {
      await chrome.storage.local.remove(storageKey(pubkey));
    } else {
      await chrome.storage.local.set({ [storageKey(pubkey)]: items });
    }
    return true;
  } catch {
    return false;
  }
}

export async function enqueuePendingPublish(
  event: NostrEvent,
  lastError?: string,
): Promise<boolean> {
  const pubkey = event.pubkey;
  const key = eventKey(event);
  const queue = await readQueue(pubkey);
  const existingIdx = queue.findIndex((item) => item.key === key);
  if (existingIdx >= 0) {
    const existing = queue[existingIdx]!;
    queue[existingIdx] = {
      ...existing,
      event,
      lastError,
    };
  } else {
    queue.push({
      pubkey,
      event,
      key,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastError,
    });
  }
  return writeQueue(pubkey, queue);
}

export async function removePendingPublish(event: NostrEvent): Promise<void> {
  const queue = await readQueue(event.pubkey);
  const key = eventKey(event);
  await writeQueue(event.pubkey, queue.filter((item) => item.key !== key));
}

export async function pendingPublishCount(pubkey: string): Promise<number> {
  return (await readQueue(pubkey)).length;
}

export async function drainPendingPublishes(nsecHex: string, pubkey: string): Promise<DrainResult> {
  let queue = await readQueue(pubkey);
  const now = Date.now();
  const fresh = queue.filter((item) => (
    item.attempts < MAX_ATTEMPTS && now - item.enqueuedAt < EXPIRE_MS
  ));
  if (fresh.length !== queue.length) {
    queue = fresh;
    await writeQueue(pubkey, queue);
  }
  if (queue.length === 0) return { attempted: 0, ok: 0, failed: 0, remaining: 0 };

  let ok = 0;
  let failed = 0;
  const stillFailing: PendingPublishItem[] = [];
  const slice = [...queue];

  for (let i = 0; i < slice.length; i += DRAIN_CONCURRENCY) {
    const batch = slice.slice(i, i + DRAIN_CONCURRENCY);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        await postSignedEventViaDeepmarks(item.event, nsecHex);
        return { item, success: true, error: undefined as string | undefined };
      } catch (error) {
        return {
          item,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    for (const result of results) {
      if (result.success) {
        ok += 1;
      } else {
        failed += 1;
        stillFailing.push({
          ...result.item,
          attempts: result.item.attempts + 1,
          lastError: result.error,
        });
      }
    }
  }

  const current = await readQueue(pubkey);
  const drainedKeys = new Set(slice.map((item) => item.key));
  const concurrentlyAdded = current.filter((item) => !drainedKeys.has(item.key));
  await writeQueue(pubkey, [...stillFailing, ...concurrentlyAdded]);

  return { attempted: slice.length, ok, failed, remaining: stillFailing.length };
}

async function postSignedEventViaDeepmarks(event: NostrEvent, nsecHex: string): Promise<void> {
  const url = `${API_BASE}/publish`;
  const body = JSON.stringify({ events: [event] });
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`publish ${res.status}: ${text.slice(0, 160)}`);
  }
}

export const pendingPublishRelay = DEEPMARKS_RELAY;
