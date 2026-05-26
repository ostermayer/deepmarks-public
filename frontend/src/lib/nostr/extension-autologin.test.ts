import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const signerState = vi.hoisted(() => ({ available: true }));
vi.mock('$lib/nostr/signers', () => ({
  createDeepmarksExtensionSigner: vi.fn(),
  isDeepmarksExtensionAvailable: () => signerState.available,
}));
vi.mock('$lib/stores/session', () => ({
  currentSession: () => ({ pubkey: null }),
  session: { login: vi.fn() },
}));

class MapBackedStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

beforeEach(() => {
  signerState.available = true;
  vi.stubGlobal('sessionStorage', new MapBackedStorage());
  vi.resetModules();
});

describe('extension auto-login', () => {
  it('can suppress automatic extension sign-in after an explicit logout', async () => {
    const {
      consumeDeepmarksAutoLoginSuppression,
      shouldAttemptDeepmarksAutoLogin,
      suppressDeepmarksAutoLoginOnce,
    } = await import('./extension-autologin.js');

    suppressDeepmarksAutoLoginOnce();

    expect(shouldAttemptDeepmarksAutoLogin()).toBe(false);
    expect(consumeDeepmarksAutoLoginSuppression()).toBe(true);
    expect(shouldAttemptDeepmarksAutoLogin()).toBe(true);
  });

  it('does not suppress explicit extension launches', async () => {
    const {
      shouldAttemptDeepmarksAutoLogin,
      suppressDeepmarksAutoLoginOnce,
    } = await import('./extension-autologin.js');

    suppressDeepmarksAutoLoginOnce();

    expect(shouldAttemptDeepmarksAutoLogin(true)).toBe(true);
  });
});
