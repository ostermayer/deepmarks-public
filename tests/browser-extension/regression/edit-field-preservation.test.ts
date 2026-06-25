// Regression guards for audit findings SYNC-F8 / PUB-F5 / SYNC-F6
// (2026-06 review), FIXED on the extension surface:
//
//   SYNC-F8  extension edits rebuilt the kind:39701 without the
//            lightning / blossom / wayback tags — archive linkage was
//            stripped from the replaceable event every device reads.
//            The builder now carries them, and a cross-surface parity
//            test pins the extension template to the web app's builder.
//   PUB-F5   direct-mode publish treated "any relay acked" as success;
//            success that missed the canonical Deepmarks relay now
//            queues a retry so server caches/search/other devices
//            actually see the save.
//   SYNC-F6  queued signed replaceable events are re-signed with drain
//            time so the relay doesn't discard them as "older".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { buildBookmarkTemplate, postSignedEvent } from '@src/lib/nostr.js';
import { drainEvent } from '@src/lib/pending-publish.js';
// The web app's builder is dependency-light (kinds.js only) — import it
// directly so the two surfaces are pinned against each other for real.
import { buildBookmarkEvent } from '../../../frontend/src/lib/nostr/bookmarks.js';

const INPUT = {
  url: 'https://example.com/article',
  title: 'Title',
  description: 'Desc',
  tags: ['alpha', 'beta'],
  publishedAt: 1_700_000_000,
  publishedAtMs: 1_700_000_000_123,
  lightning: 'tips@example.com',
  blossomHash: 'b'.repeat(64),
  waybackUrl: 'https://web.archive.org/web/2026/https://example.com/article',
  archivedForever: true,
};

describe('SYNC-F8: extension bookmark template carries every field', () => {
  it('emits lightning, blossom, wayback, and archive-tier tags', () => {
    const tags = buildBookmarkTemplate(INPUT).tags;
    const find = (name: string) => tags.find((t) => t[0] === name)?.[1];

    expect(find('lightning')).toBe('tips@example.com');
    expect(find('blossom')).toBe('b'.repeat(64));
    expect(find('wayback')).toContain('web.archive.org');
    expect(find('archive-tier')).toBe('forever');
  });

  it('matches the web app builder tag-for-tag (cross-surface parity)', () => {
    const extensionTags = buildBookmarkTemplate(INPUT).tags;
    const webTags = buildBookmarkEvent(INPUT).tags;

    expect(extensionTags).toEqual(webTags);
  });
});

describe('PUB-F5: direct-mode publish requires the canonical relay', () => {
  function installChromeStorage() {
    const storage = new Map<string, unknown>();
    globalThis.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) storage.set(key, value);
          }),
          remove: vi.fn(async (key: string) => void storage.delete(key)),
        },
      },
    } as unknown as typeof chrome;
    return storage;
  }

  function signedEvent(sk: Uint8Array) {
    return finalizeEvent(
      { kind: 39701, created_at: 1_700_000_000, tags: [['d', 'https://example.com/']], content: '' },
      sk,
    );
  }

  beforeEach(() => {
    installChromeStorage();
  });

  it('queues a retry when only third-party relays ack', async () => {
    const sk = generateSecretKey();
    const event = signedEvent(sk);
    const pool = {
      publish: vi.fn((relays: string[]) => relays.map((relay) => (
        relay.includes('deepmarks') ? Promise.reject(new Error('timeout')) : Promise.resolve('ok')
      ))),
    };

    const result = await postSignedEvent(event, bytesToHex(sk), {
      mode: 'direct',
      relays: ['wss://nos.lol', 'wss://relay.deepmarks.org'],
      pool: pool as never,
      timeoutMs: 100,
    });

    // Partial result reported honestly…
    expect(result.ok).toEqual(['wss://nos.lol']);
    // …and the canonical-relay miss is queued for retry.
    const stored = await chrome.storage.local.get(`deepmarks-pending-publish:${event.pubkey}`);
    const queue = stored[`deepmarks-pending-publish:${event.pubkey}`] as unknown[];
    expect(Array.isArray(queue) && queue.length).toBe(1);
  });

  it('does not queue when the canonical relay acked', async () => {
    const sk = generateSecretKey();
    const event = signedEvent(sk);
    const pool = {
      publish: vi.fn((relays: string[]) => relays.map(() => Promise.resolve('ok'))),
    };

    await postSignedEvent(event, bytesToHex(sk), {
      mode: 'direct',
      relays: ['wss://relay.deepmarks.org'],
      pool: pool as never,
      timeoutMs: 100,
    });

    const stored = await chrome.storage.local.get(`deepmarks-pending-publish:${event.pubkey}`);
    expect(stored[`deepmarks-pending-publish:${event.pubkey}`] ?? []).toEqual([]);
  });
});

describe('SYNC-F6: queued replaceable events are re-signed at drain time', () => {
  it('re-stamps and re-signs a stale d-tag event, keeping a valid signature', () => {
    const sk = generateSecretKey();
    const nsecHex = bytesToHex(sk);
    const stale = finalizeEvent(
      { kind: 39701, created_at: 1_700_000_000, tags: [['d', 'https://example.com/']], content: '' },
      sk,
    );

    const drained = drainEvent(stale, nsecHex);

    expect(drained.created_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
    expect(drained.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(drained)).toBe(true);
  });

  it('leaves non-replaceable events untouched', () => {
    const sk = generateSecretKey();
    const note = finalizeEvent(
      { kind: 1, created_at: 1_700_000_000, tags: [], content: 'hi' },
      sk,
    );

    expect(drainEvent(note, bytesToHex(sk))).toBe(note);
  });
});
