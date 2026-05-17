// Durable publish queue.
//
// When publishEvent can't get even one relay to ack within its
// timeout, we used to just hand back `publishRelayCount: 0` and trust
// the caller to surface it. In practice users miss that warning, the
// bookmark exists only in localStorage, and a different client never
// sees it. That broke "Deepmarks doesn't lose bookmarks".
//
// This module persists those failed templates in localStorage. We
// drain the queue on:
//   • app load (after rehydrate)
//   • foreground (visibilitychange / Capacitor appStateChange)
//   • a periodic timer while the app is open
//
// Drain re-runs publishEvent with the saved signer (NDK reads it
// directly), removes successful items, and increments the attempts
// counter on failures. Items that pass MAX_ATTEMPTS or sit older than
// EXPIRE_DAYS get dropped so the queue can't grow without bound.

import { browser } from '$app/environment';
import type { UnsignedEventTemplate } from './bookmarks.js';

const STORAGE_PREFIX = 'deepmarks-pending-publish:';
const MAX_ATTEMPTS = 30;
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;
/** Max concurrent publishes when draining. Keeps the first drain on a
 *  long queue from making 4000 simultaneous WebSocket requests. */
const DRAIN_CONCURRENCY = 4;

export interface PendingPublishItem {
  pubkey: string;
  template: UnsignedEventTemplate;
  /** Stable key — kind + d-tag for replaceable, or event id when known.
   *  Used to dedupe so re-enqueuing the same replaceable event collapses
   *  to one entry. */
  key: string;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}${pubkey}`;
}

function templateKey(pubkey: string, template: UnsignedEventTemplate): string {
  const d = template.tags.find((t) => t[0] === 'd')?.[1];
  if (d) return `${pubkey}:k${template.kind}:d=${d}`;
  // Non-addressable: include created_at + content hash-ish. Two saves
  // of the same payload within a second collapse, which matches what
  // the relay would do anyway (same event id).
  const fp = `${template.created_at}:${template.content.length}`;
  return `${pubkey}:k${template.kind}:t=${fp}`;
}

function readQueue(pubkey: string): PendingPublishItem[] {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingPublishItem => (
      !!item
      && typeof item.pubkey === 'string'
      && typeof item.key === 'string'
      && typeof item.attempts === 'number'
      && typeof item.enqueuedAt === 'number'
      && item.template
      && typeof item.template === 'object'
      && typeof item.template.kind === 'number'
    ));
  } catch {
    return [];
  }
}

function writeQueue(pubkey: string, items: PendingPublishItem[]): void {
  if (!browser) return;
  try {
    if (items.length === 0) {
      localStorage.removeItem(storageKey(pubkey));
    } else {
      localStorage.setItem(storageKey(pubkey), JSON.stringify(items));
    }
  } catch {
    /* tolerable — quota / private mode */
  }
}

export function enqueuePendingPublish(
  template: UnsignedEventTemplate,
  pubkey: string,
  lastError?: string,
): void {
  if (!browser) return;
  const key = templateKey(pubkey, template);
  const queue = readQueue(pubkey);
  const existingIdx = queue.findIndex((item) => item.key === key);
  if (existingIdx >= 0) {
    const existing = queue[existingIdx]!;
    queue[existingIdx] = {
      ...existing,
      template,
      attempts: existing.attempts,
      lastError,
    };
  } else {
    queue.push({
      pubkey,
      template,
      key,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastError,
    });
  }
  writeQueue(pubkey, queue);
}

export function pendingPublishCount(pubkey: string): number {
  return readQueue(pubkey).length;
}

let draining = false;
let publishImpl: ((template: UnsignedEventTemplate, pubkey: string) => Promise<{ relays: string[] }>) | null = null;

/** Late-bound to avoid the circular import publish.ts → pending-publish.ts → publish.ts. */
export function setPendingPublishImpl(
  impl: (template: UnsignedEventTemplate, pubkey: string) => Promise<{ relays: string[] }>,
): void {
  publishImpl = impl;
}

export interface DrainResult {
  attempted: number;
  ok: number;
  failed: number;
  remaining: number;
}

export async function drainPendingPublishes(pubkey: string): Promise<DrainResult> {
  if (draining || !publishImpl) return { attempted: 0, ok: 0, failed: 0, remaining: 0 };
  draining = true;
  try {
    let queue = readQueue(pubkey);
    // Drop stale entries up-front so an unrecoverable item doesn't
    // permanently block its slot.
    const now = Date.now();
    const fresh = queue.filter((item) => (
      item.attempts < MAX_ATTEMPTS && (now - item.enqueuedAt) < EXPIRE_MS
    ));
    if (fresh.length !== queue.length) {
      queue = fresh;
      writeQueue(pubkey, queue);
    }
    if (queue.length === 0) return { attempted: 0, ok: 0, failed: 0, remaining: 0 };

    let ok = 0;
    let failed = 0;
    const stillFailing: PendingPublishItem[] = [];
    // Snapshot first so concurrent enqueues during the drain land on
    // disk without us double-touching them.
    const slice = [...queue];

    for (let i = 0; i < slice.length; i += DRAIN_CONCURRENCY) {
      const batch = slice.slice(i, i + DRAIN_CONCURRENCY);
      const results = await Promise.all(batch.map(async (item) => {
        try {
          const res = await publishImpl!(item.template, item.pubkey);
          return { item, success: res.relays.length > 0, error: undefined as string | undefined };
        } catch (err) {
          return {
            item,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }));
      for (const { item, success, error } of results) {
        if (success) {
          ok += 1;
        } else {
          failed += 1;
          stillFailing.push({
            ...item,
            attempts: item.attempts + 1,
            lastError: error,
          });
        }
      }
    }

    // Replace queue with the failed-and-not-yet-expired survivors plus
    // anything that got enqueued while we were draining. Reload the
    // disk copy so we don't clobber concurrent appends.
    const current = readQueue(pubkey);
    const drainedKeys = new Set(slice.map((item) => item.key));
    const concurrentlyAdded = current.filter((item) => !drainedKeys.has(item.key));
    writeQueue(pubkey, [...stillFailing, ...concurrentlyAdded]);

    return { attempted: slice.length, ok, failed, remaining: stillFailing.length };
  } finally {
    draining = false;
  }
}
