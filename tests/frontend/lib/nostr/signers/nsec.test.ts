import { describe, it, expect } from 'vitest';

// No NDK mock: as of NDK 3.x NDKPrivateKeySigner is pure-JS (noble/nostr-tools
// under the hood), so the real class runs fine under node — and using it pins
// real hex validation and real pubkey derivation instead of stub echoes
// (2026-08-22 review: the old mock accepted inputs the real constructor
// rejects, and the happy-path tests only asserted the stub's own output).
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { createNsecSigner } from '$lib/nostr/signers/nsec.js';
import { SignerError } from '$lib/nostr/signers/types.js';

async function expectInvalidKey(input: string): Promise<SignerError> {
  try {
    await createNsecSigner(input);
  } catch (e) {
    expect(e).toBeInstanceOf(SignerError);
    expect((e as SignerError).code).toBe('invalid-key');
    return e as SignerError;
  }
  throw new Error(`expected createNsecSigner(${JSON.stringify(input.slice(0, 12))}…) to reject`);
}

describe('createNsecSigner', () => {
  it('accepts a bech32 nsec1 string and derives the real pubkey', async () => {
    const sk = generateSecretKey();
    const signer = await createNsecSigner(nip19.nsecEncode(sk));
    expect(signer.kind).toBe('nsec');
    expect(signer.pubkey).toBe(getPublicKey(sk));
    expect(signer.nsecHex).toBe(bytesToHex(sk));
  });

  it('accepts an ALL-UPPERCASE bech32 encoding (QR alphanumeric mode)', async () => {
    const sk = generateSecretKey();
    const signer = await createNsecSigner(nip19.nsecEncode(sk).toUpperCase());
    expect(signer.pubkey).toBe(getPublicKey(sk));
  });

  it('accepts a 64-char hex string (case-insensitive) and normalizes to lowercase', async () => {
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const signer = await createNsecSigner(hex.toUpperCase());
    expect(signer.kind).toBe('nsec');
    expect(signer.pubkey).toBe(getPublicKey(sk));
    expect(signer.nsecHex).toBe(hex);
  });

  it('rejects a typo´d nsec WITHOUT echoing the pasted secret in the message', async () => {
    // Regression (2026-08-22): nip19.decode's checksum error contains the
    // full pasted string, and the login page renders signer error messages
    // into the DOM — a near-complete secret key appeared on screen.
    const nsec = nip19.nsecEncode(generateSecretKey());
    const typoed = nsec.slice(0, -1) + (nsec.endsWith('x') ? 'y' : 'x');
    const err = await expectInvalidKey(typoed);
    expect(err.message).not.toContain(typoed.slice(5, 20));
    expect(err.message).toMatch(/not a valid nsec/i);
  });

  it('rejects an npub (the public half of the keypair)', async () => {
    const sk = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(sk));
    await expectInvalidKey(npub);
  });

  it('rejects gibberish with a clear error message', async () => {
    const err = await expectInvalidKey('not-a-key');
    expect(err.message).toMatch(/nsec1.*hex/i);
  });

  it('rejects hex of the wrong length', async () => {
    await expectInvalidKey('00ff');
  });

  it('rejects 64-char hex that is not a valid secp256k1 scalar', async () => {
    // All-zeros and ≥-curve-order values pass the shape check but make the
    // real NDKPrivateKeySigner throw a raw noble Error — the signer must
    // convert that to SignerError('invalid-key') for the login UI.
    await expectInvalidKey('0'.repeat(64));
    await expectInvalidKey('f'.repeat(64));
  });

  it('trims whitespace and invisible characters on both branches', async () => {
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const nsec = nip19.nsecEncode(sk);
    expect((await createNsecSigner(`   ${hex}\n`)).pubkey).toBe(getPublicKey(sk));
    expect((await createNsecSigner(`\u200B  ${nsec}\u200D\n`)).pubkey).toBe(getPublicKey(sk));
  });
});
