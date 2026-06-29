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
