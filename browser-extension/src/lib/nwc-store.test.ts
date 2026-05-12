import { beforeEach, describe, expect, it, vi } from 'vitest';

let cachedKey: CryptoKey | null = null;
let accountProtected = true;

vi.mock('./nsec-store.js', () => ({
  getCachedAccountEncryptionKey: () => Promise.resolve(cachedKey),
  nsecStore: {
    getState: () => Promise.resolve({
      empty: false,
      locked: accountProtected && !cachedKey,
      protected: accountProtected,
      pubkey: 'c'.repeat(64),
      nsecHex: cachedKey ? 'd'.repeat(64) : null,
      signedInAt: 1,
    }),
  },
}));

const storage = new Map<string, unknown>();

function installChromeMock() {
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
          storage.delete(key);
        }),
      },
    },
  } as unknown as typeof chrome;
}

async function makeKey(seed: number): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(seed),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

const conn = {
  walletPubkey: 'a'.repeat(64),
  relayUrl: 'wss://relay.example.com',
  appSecret: 'b'.repeat(64),
  lud16: 'user@example.com',
  connectedAt: 123,
};

describe('nwc-store', () => {
  beforeEach(async () => {
    storage.clear();
    accountProtected = true;
    cachedKey = await makeKey(7);
    installChromeMock();
    vi.resetModules();
  });

  it('stores new NWC connections encrypted at rest', async () => {
    const { loadNwc, saveNwc } = await import('./nwc-store.js');

    await saveNwc(conn);

    const stored = storage.get('deepmarks-nwc') as Record<string, unknown>;
    expect(stored.encrypted).toBe(true);
    expect(stored.walletPubkey).toBe(conn.walletPubkey);
    expect(stored.relayUrl).toBe(conn.relayUrl);
    expect(stored.appSecret).toBeUndefined();
    expect(stored.appSecretBlob).toEqual(expect.objectContaining({
      cipher: 'aes-gcm-256',
      ciphertextB64: expect.any(String),
      ivB64: expect.any(String),
    }));
    await expect(loadNwc()).resolves.toEqual(conn);
  });

  it('refuses to save when the account password key is locked', async () => {
    cachedKey = null;
    const { saveNwc } = await import('./nwc-store.js');

    await expect(saveNwc(conn)).rejects.toThrow('Set or unlock your Deepmarks password');
    expect(storage.has('deepmarks-nwc')).toBe(false);
  });

  it('migrates legacy plaintext NWC once the password key is unlocked', async () => {
    const { loadNwc } = await import('./nwc-store.js');
    storage.set('deepmarks-nwc', conn);

    await expect(loadNwc()).resolves.toEqual(conn);

    const stored = storage.get('deepmarks-nwc') as Record<string, unknown>;
    expect(stored.encrypted).toBe(true);
    expect(stored.appSecret).toBeUndefined();
  });
});
