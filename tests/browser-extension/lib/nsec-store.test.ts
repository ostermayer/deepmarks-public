import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorage = new Map<string, unknown>();
const sessionStorage = new Map<string, unknown>();

function installChromeMock() {
  globalThis.chrome = {
    storage: {
      local: makeStorageArea(localStorage),
      session: makeStorageArea(sessionStorage),
    },
  } as unknown as typeof chrome;
}

function makeStorageArea(storage: Map<string, unknown>) {
  return {
    get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) storage.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  };
}

describe('nsec-store cached key handling', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    installChromeMock();
    vi.resetModules();
  });

  it('ignores a corrupt session key and clears any legacy persistent key cache', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');

    const initial = await nsecStore.setEncrypted('1'.repeat(64), 'correct horse battery staple', 'days30');
    expect(initial.locked).toBe(false);

    sessionStorage.set('deepmarks-derived-key', 'not valid base64');
    localStorage.set('deepmarks-derived-key-cached', {
      keyB64: 'legacy cache',
      expiresAt: Date.now() + 60_000,
    });

    const state = await nsecStore.getState();

    expect(state.locked).toBe(true);
    expect(state.nsecHex).toBeNull();
    expect(sessionStorage.has('deepmarks-derived-key')).toBe(false);
    expect(localStorage.has('deepmarks-derived-key-cached')).toBe(false);
  });

  it('treats a corrupt persistent key as locked instead of throwing', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');

    const initial = await nsecStore.setEncrypted('2'.repeat(64), 'correct horse battery staple', 'days30');
    expect(initial.locked).toBe(false);

    sessionStorage.delete('deepmarks-derived-key');
    localStorage.set('deepmarks-derived-key-cached', {
      keyB64: 'not valid base64',
      expiresAt: Date.now() + 60_000,
    });

    const state = await nsecStore.getState();

    expect(state.protected).toBe(true);
    expect(state.locked).toBe(true);
    expect(state.nsecHex).toBeNull();
    expect(localStorage.has('deepmarks-derived-key-cached')).toBe(false);
  });

  it('uses a valid 30-day cached key after session storage is cleared', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');

    await nsecStore.setEncrypted('5'.repeat(64), 'correct horse battery staple', 'days30');
    sessionStorage.delete('deepmarks-derived-key');

    const state = await nsecStore.getState();

    expect(state.locked).toBe(false);
    expect(state.nsecHex).toBe('5'.repeat(64));
    expect(sessionStorage.has('deepmarks-derived-key')).toBe(true);
  });

  it('does not write a persistent key for session-only unlocks', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');

    await nsecStore.setEncrypted('6'.repeat(64), 'correct horse battery staple', 'session');

    expect(localStorage.has('deepmarks-derived-key-cached')).toBe(false);
  });

  it('reports a wrong unlock password plainly', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');

    await nsecStore.setEncrypted('3'.repeat(64), 'correct horse battery staple', 'session');
    await nsecStore.lock();

    await expect(nsecStore.unlock('wrong password')).rejects.toThrow('password is incorrect');
  });

  it('reports a wrong current password plainly during password change', async () => {
    const { nsecStore, deriveAccountEncryptionKey } = await import('@src/lib/nsec-store.js');

    await nsecStore.setEncrypted('4'.repeat(64), 'correct horse battery staple', 'session');

    await expect(deriveAccountEncryptionKey('wrong password')).rejects.toThrow(
      'current password is incorrect',
    );
    await expect(nsecStore.changePassword('wrong password', 'new correct horse battery staple')).rejects.toThrow(
      'current password is incorrect',
    );
  });
});

describe('nsec-store input validation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    installChromeMock();
    vi.resetModules();
  });

  it('rejects a typo´d nsec WITHOUT echoing the pasted secret', async () => {
    // Same bug class as the web app's nsec signer (fixed 2026-08-22):
    // nip19.decode's checksum error contains the full pasted string, and
    // Login.tsx renders (e as Error).message into the popup DOM.
    const { nsecStore } = await import('@src/lib/nsec-store.js');
    const { generateSecretKey, nip19 } = await import('nostr-tools');
    const nsec = nip19.nsecEncode(generateSecretKey());
    const typoed = nsec.slice(0, -1) + (nsec.endsWith('x') ? 'y' : 'x');
    try {
      await nsecStore.setEncrypted(typoed, 'correct horse battery staple');
      throw new Error('expected setEncrypted to reject');
    } catch (e) {
      expect((e as Error).message).not.toContain(typoed.slice(5, 20));
      expect((e as Error).message).toMatch(/not a valid nsec/i);
    }
  });

  it('accepts an ALL-UPPERCASE bech32 nsec (QR alphanumeric mode)', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');
    const { generateSecretKey, getPublicKey, nip19 } = await import('nostr-tools');
    const sk = generateSecretKey();
    const state = await nsecStore.setEncrypted(
      nip19.nsecEncode(sk).toUpperCase(),
      'correct horse battery staple',
    );
    expect(state.locked).toBe(false);
    expect(state.pubkey).toBe(getPublicKey(sk));
  });

  it('rejects curve-invalid 64-hex with a friendly message, not a noble error', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');
    await expect(nsecStore.setEncrypted('0'.repeat(64), 'pw-123456'))
      .rejects.toThrow(/secp256k1/);
    await expect(nsecStore.setEncrypted('f'.repeat(64), 'pw-123456'))
      .rejects.toThrow(/secp256k1/);
  });

  it('rejects gibberish with the expected-format message', async () => {
    const { nsecStore } = await import('@src/lib/nsec-store.js');
    await expect(nsecStore.setEncrypted('not-a-key', 'pw-123456'))
      .rejects.toThrow(/nsec1.*hex/i);
  });
});
