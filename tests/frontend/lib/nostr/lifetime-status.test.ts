import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifetimeStatusMock = vi.hoisted(() => vi.fn());

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api/client.js', () => ({
  api: {
    lifetime: {
      status: lifetimeStatusMock,
    },
  },
}));

import { invalidateLifetimeStatus, isLifetimeMemberOnce, setLifetimeStatus } from '$lib/nostr/lifetime-status';

const PUBKEY = 'a'.repeat(64);

class MemoryStorage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const memStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage =
  memStorage as unknown as Storage;

beforeEach(() => {
  memStorage.clear();
  lifetimeStatusMock.mockReset();
  invalidateLifetimeStatus(PUBKEY);
});

describe('isLifetimeMemberOnce', () => {
  it('trusts a positive local cache without hitting the API', async () => {
    setLifetimeStatus(PUBKEY, true);

    await expect(isLifetimeMemberOnce(PUBKEY)).resolves.toBe(true);
    expect(lifetimeStatusMock).not.toHaveBeenCalled();
  });

  it('does not let a fresh negative cache hide a server-side paid membership', async () => {
    setLifetimeStatus(PUBKEY, false);
    lifetimeStatusMock.mockResolvedValue({
      pubkey: PUBKEY,
      isLifetimeMember: true,
      paidAt: 1_776_975_052,
    });

    await expect(isLifetimeMemberOnce(PUBKEY)).resolves.toBe(true);
    expect(lifetimeStatusMock).toHaveBeenCalledWith(PUBKEY);
  });

  it('falls back to a cached negative only when the live check fails', async () => {
    setLifetimeStatus(PUBKEY, false);
    lifetimeStatusMock.mockRejectedValue(new Error('offline'));

    await expect(isLifetimeMemberOnce(PUBKEY)).resolves.toBe(false);
  });
});
