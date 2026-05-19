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
  vi.stubGlobal('sessionStorage', new MapBackedStorage());
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

  it('tracks persisted pubkey-only sessions while signer rehydration runs', async () => {
    const pubkey = getPublicKey(generateSecretKey());
    localStorage.setItem(
      'deepmarks-session-hint',
      JSON.stringify({ kind: 'nsec', npub: nip19.npubEncode(pubkey) }),
    );

    const { session, isAuthenticated, canSign, sessionRestoring } = await import('./session.js');
    expect(get(isAuthenticated)).toBe(true);
    expect(get(canSign)).toBe(false);
    expect(get(sessionRestoring)).toBe(true);

    await session.rehydrate();

    expect(get(isAuthenticated)).toBe(true);
    expect(get(canSign)).toBe(false);
    expect(get(sessionRestoring)).toBe(false);
  });

  it('restores a persisted nsec signer from localStorage', async () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    localStorage.setItem(
      'deepmarks-session-hint',
      JSON.stringify({ kind: 'nsec', npub: nip19.npubEncode(pubkey) }),
    );
    localStorage.setItem('deepmarks-session-nsec', bytesToHex(sk));

    const { session, isAuthenticated, canSign, sessionRestoring } = await import('./session.js');
    expect(get(isAuthenticated)).toBe(true);
    expect(get(sessionRestoring)).toBe(true);

    await session.rehydrate();

    expect(get(isAuthenticated)).toBe(true);
    expect(get(canSign)).toBe(true);
    expect(get(sessionRestoring)).toBe(false);
    expect(localStorage.getItem('deepmarks-session-hint')).not.toBeNull();
    expect(localStorage.getItem('deepmarks-session-nsec')).toBe(bytesToHex(sk));
  });

  it('clears a persisted nsec when it does not match the stored hint', async () => {
    const hintedPubkey = getPublicKey(generateSecretKey());
    const otherSecret = generateSecretKey();
    localStorage.setItem(
      'deepmarks-session-hint',
      JSON.stringify({ kind: 'nsec', npub: nip19.npubEncode(hintedPubkey) }),
    );
    localStorage.setItem('deepmarks-session-nsec', bytesToHex(otherSecret));

    const { session, isAuthenticated, canSign, sessionRestoring } = await import('./session.js');
    expect(get(isAuthenticated)).toBe(true);
    expect(get(sessionRestoring)).toBe(true);

    await session.rehydrate();

    expect(get(isAuthenticated)).toBe(false);
    expect(get(canSign)).toBe(false);
    expect(get(sessionRestoring)).toBe(false);
    expect(localStorage.getItem('deepmarks-session-hint')).toBeNull();
    expect(localStorage.getItem('deepmarks-session-nsec')).toBeNull();
  });

  it('logout clears the hint and detaches the signer', async () => {
    const { session, isAuthenticated } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    await session.login({ kind: 'nip07', pubkey, ndk: mockSigner as never });
    await session.logout();
    expect(get(isAuthenticated)).toBe(false);
    expect(ndkStub.signer).toBeUndefined();
    expect(localStorage.getItem('deepmarks-session-hint')).toBeNull();
  });

  it('can keep an nsec signer memory-only for passkey-backed sessions', async () => {
    const { session } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const nsecHex = bytesToHex(sk);
    await session.login(
      { kind: 'nsec', pubkey, ndk: mockSigner as never, nsecHex },
      { persistNsec: false },
    );
    expect(localStorage.getItem('deepmarks-session-hint')).not.toBeNull();
    expect(localStorage.getItem('deepmarks-session-nsec')).toBeNull();
  });

  it('can persist an nsec signer when requested', async () => {
    const { session } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const nsecHex = bytesToHex(sk);
    await session.login(
      { kind: 'nsec', pubkey, ndk: mockSigner as never, nsecHex },
      { persistNsec: true },
    );
    expect(localStorage.getItem('deepmarks-session-hint')).not.toBeNull();
    expect(localStorage.getItem('deepmarks-session-nsec')).toBe(nsecHex);
  });

  it('can attach a signer ephemerally without persisting an account hint', async () => {
    const { session, canSign, isAuthenticated } = await import('./session.js');
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);

    await session.attachEphemeral({ kind: 'nsec', pubkey, ndk: mockSigner as never, nsecHex: bytesToHex(sk) });

    expect(ndkStub.signer).toBe(mockSigner);
    expect(get(canSign)).toBe(true);
    expect(get(isAuthenticated)).toBe(true);
    expect(localStorage.getItem('deepmarks-session-hint')).toBeNull();
    expect(localStorage.getItem('deepmarks-session-nsec')).toBeNull();
  });

  it('clears an ephemeral signer without clearing an unrelated persisted hint', async () => {
    const { session, npub, canSign } = await import('./session.js');
    const oldPubkey = getPublicKey(generateSecretKey());
    const transientPubkey = getPublicKey(generateSecretKey());
    localStorage.setItem(
      'deepmarks-session-hint',
      JSON.stringify({ kind: 'nsec', npub: nip19.npubEncode(oldPubkey) }),
    );

    const transient = {
      kind: 'nsec' as const,
      pubkey: transientPubkey,
      ndk: mockSigner as never,
      nsecHex: bytesToHex(generateSecretKey()),
    };
    await session.attachEphemeral(transient);
    await session.clearEphemeral(transient);

    expect(ndkStub.signer).toBeUndefined();
    expect(get(canSign)).toBe(false);
    expect(get(npub)).toBe(nip19.npubEncode(oldPubkey));
    expect(localStorage.getItem('deepmarks-session-hint')).not.toBeNull();
  });
});

// Suppress unused-import warning for utilities only used in fixture construction.
void bytesToHex;
