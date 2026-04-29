import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

vi.mock('$app/environment', () => ({ browser: true }));

const mockSigner = { kind: 'mock' };
const ndkStub = { signer: undefined as unknown };
vi.mock('$lib/nostr/ndk', () => ({
  getNdk: () => ndkStub
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
  vi.stubGlobal('localStorage', new MapBackedStorage());
  ndkStub.signer = undefined;
  vi.resetModules();
});

describe('session store', () => {
  it('login attaches the signer to NDK and surfaces the npub', async () => {
    const { session, npub, isAuthenticated, canSign } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    await session.login({ kind: 'nip07', pubkey, ndk: mockSigner as never });
    expect(ndkStub.signer).toBe(mockSigner);
    expect(get(npub)).toBe(nip19.npubEncode(pubkey));
    expect(get(isAuthenticated)).toBe(true);
    expect(get(canSign)).toBe(true);
  });

  it('persists a hint with kind + npub but never the signer itself', async () => {
    const { session } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    await session.login({ kind: 'nip07', pubkey, ndk: mockSigner as never });
    const raw = localStorage.getItem('deepmarks-session-hint');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.kind).toBe('nip07');
    expect(parsed.npub).toBe(nip19.npubEncode(pubkey));
    expect(parsed).not.toHaveProperty('signer');
    expect(parsed).not.toHaveProperty('nsec');
  });

  it('logout clears the hint and detaches the signer', async () => {
    const { session, isAuthenticated } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    await session.login({ kind: 'nip07', pubkey, ndk: mockSigner as never });
    session.logout();
    expect(get(isAuthenticated)).toBe(false);
    expect(ndkStub.signer).toBeUndefined();
    expect(localStorage.getItem('deepmarks-session-hint')).toBeNull();
  });
});

// Suppress unused-import warning for utilities only used in fixture construction.
void bytesToHex;
