// Regression guards for audit finding PUB-F7 (2026-06 review): the durable
// publish queue dedupes replaceable events by (pubkey, kind, d-tag). When a
// save and a quick follow-up edit of the same URL overlap, the edit replaces
// the save's queue entry under the same key — and the save's later POST
// success then calls removePendingPublish, which removes BY KEY and deletes
// the edit's entry. If the edit's own POST subsequently fails it is never
// re-enqueued (it believes it is still queued), so the edit is silently lost.
//
// FIXED: removePendingPublish now matches the exact template, not just
// the dedupe key — these tests are permanent guards.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  enqueuePendingPublish,
  removePendingPublish,
  pendingPublishCount,
} from '$lib/nostr/pending-publish.js';
import type { UnsignedEventTemplate } from '$lib/nostr/bookmarks.js';

const PUBKEY = 'a'.repeat(64);
const URL = 'https://example.com/article';

function template(overrides: Partial<UnsignedEventTemplate> = {}): UnsignedEventTemplate {
  return {
    kind: 39701,
    created_at: 1_700_000_000,
    tags: [['d', URL], ['title', 'original']],
    content: '',
    ...overrides,
  };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('durable publish queue dedupe', () => {
  it('collapses re-enqueues of the same replaceable event into one entry', () => {
    enqueuePendingPublish(template(), PUBKEY);
    enqueuePendingPublish(template({ created_at: 1_700_000_010 }), PUBKEY);

    expect(pendingPublishCount(PUBKEY)).toBe(1);
  });

  it('removes an entry when its own template is acknowledged', () => {
    const saved = template();
    enqueuePendingPublish(saved, PUBKEY);
    removePendingPublish(saved, PUBKEY);

    expect(pendingPublishCount(PUBKEY)).toBe(0);
  });

  // The original save's success acknowledgement must not delete a NEWER
  // queued edit that replaced it under the same (kind, d-tag) key.
  it('keeps a newer queued edit when an older publish of the same key succeeds', () => {
    const save = template();
    const edit = template({
      created_at: save.created_at + 30,
      tags: [['d', URL], ['title', 'edited title']],
    });

    enqueuePendingPublish(save, PUBKEY);
    enqueuePendingPublish(edit, PUBKEY); // replaces the save's slot
    removePendingPublish(save, PUBKEY); // the save's POST succeeded

    // The edit is still unpublished — it must survive in the queue.
    expect(pendingPublishCount(PUBKEY)).toBe(1);
  });
});
