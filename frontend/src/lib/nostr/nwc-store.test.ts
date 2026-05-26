import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

const state = vi.hoisted(() => ({
  nativeShell: false,
  secureStore: new Map<string, string>(),
  session: { signer: undefined as { kind?: string; nsecHex?: string } | undefined },
}));

vi.mock('$lib/native/runtime', () => ({
  isNativeShell: () => state.nativeShell,
}));

vi.mock('$lib/mobile/secure-store', () => ({
  secureGet: vi.fn(async (key: string) => state.secureStore.get(key) ?? null),
  secureSet: vi.fn(async (key: string, value: string) => {
    state.secureStore.set(key, value);
  }),
  secureRemove: vi.fn(async (key: string) => {
    state.secureStore.delete(key);
  }),
}));

vi.mock('$lib/stores/session', () => ({
  currentSession: () => state.session,
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

function walletConnection() {
  return {
    walletPubkey: 'a'.repeat(64),
    relayUrl: 'wss://wallet.example',
    appSecret: 'b'.repeat(64),
    connectedAt: 1,
  };
}

beforeEach(() => {
  state.nativeShell = false;
  state.secureStore.clear();
  state.session = { signer: undefined };
  vi.stubGlobal('localStorage', new MapBackedStorage());
  vi.resetModules();
});

describe('nwc-store', () => {
  it('keeps web signer sessions locked without a local recovery key', async () => {
    const { saveNwc } = await import('./nwc-store.js');

    await expect(saveNwc(walletConnection())).rejects.toThrow(
      'Sign in with a passkey or recovery key before saving NWC on this device',
    );
    expect(state.secureStore.size).toBe(0);
  });

  it('saves native NWC through secure storage when signed in with an external signer', async () => {
    state.nativeShell = true;
    state.session = { signer: { kind: 'android-signer' } };
    const { saveNwc, loadNwc } = await import('./nwc-store.js');

    const conn = walletConnection();
    await saveNwc(conn);

    expect(localStorage.getItem('deepmarks-nwc')).toBeNull();
    expect(state.secureStore.get('deepmarks-nwc')).toContain('native-secure-store');
    await expect(loadNwc()).resolves.toEqual(conn);
  });
});
