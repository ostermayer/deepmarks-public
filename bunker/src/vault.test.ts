import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { Vault, parseNsec } from './vault.js';

// One temp dir per test run; cleaned up in afterEach.
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-vault-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeNsecFile(name: string, value: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, value + '\n', { mode: 0o400 });
  return p;
}

describe('parseNsec', () => {
  it('decodes bech32 nsec1…', () => {
    const sk = generateSecretKey();
    const encoded = nip19.nsecEncode(sk);
    const decoded = parseNsec(encoded);
    expect(decoded).toEqual(sk);
  });

  it('decodes 64-char hex', () => {
    const sk = generateSecretKey();
    const hex = Array.from(sk)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(parseNsec(hex)).toEqual(sk);
  });

  it('rejects garbage', () => {
    expect(() => parseNsec('not-a-key')).toThrow();
    expect(() => parseNsec('')).toThrow();
    expect(() => parseNsec('nsec1invalid')).toThrow();
  });

  it('rejects bech32 types other than nsec (npub, nevent, etc.)', () => {
    const sk = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(sk));
    // npub doesn't start with 'nsec1' and isn't 64-char hex, so it hits
    // the generic reject — that's intentional: we never decode anything
    // that doesn't look like a private key from the first 5 chars.
    expect(() => parseNsec(npub)).toThrow();
  });
});

describe('Vault.load', () => {
  it('loads two identities and exposes pubkeys', () => {
    const brandSk = generateSecretKey();
    const personalSk = generateSecretKey();
    const brandPath = writeNsecFile('brand.nsec', nip19.nsecEncode(brandSk));
    const personalPath = writeNsecFile('personal.nsec', nip19.nsecEncode(personalSk));

    const vault = Vault.load([
      { identity: 'brand', path: brandPath },
      { identity: 'personal', path: personalPath },
    ]);

    expect(vault.pubkeyFor('brand')).toBe(getPublicKey(brandSk));
    expect(vault.pubkeyFor('personal')).toBe(getPublicKey(personalSk));
    expect(vault.entries()).toHaveLength(2);
  });

  it('throws on missing file', () => {
    expect(() =>
      Vault.load([{ identity: 'brand', path: path.join(tmp, 'nope.nsec') }]),
    ).toThrow();
  });
});

describe('Vault.sign', () => {
  it('returns a valid signed event', () => {
    const sk = generateSecretKey();
    const p = writeNsecFile('brand.nsec', nip19.nsecEncode(sk));
    const vault = Vault.load([{ identity: 'brand', path: p }]);

    const signed = vault.sign('brand', {
      kind: 9735,
      content: '',
      tags: [['p', 'f'.repeat(64)]],
      created_at: 1_700_000_000,
    });

    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(signed.kind).toBe(9735);
    expect(verifyEvent(signed)).toBe(true);
  });

  it('throws on unknown identity', () => {
    const sk = generateSecretKey();
    const p = writeNsecFile('brand.nsec', nip19.nsecEncode(sk));
    const vault = Vault.load([{ identity: 'brand', path: p }]);
    expect(() =>
      vault.sign('personal', { kind: 9735, content: '', tags: [], created_at: 0 }),
    ).toThrow(/not loaded/);
  });
});
