import { describe, it, expect, vi } from 'vitest';

// nostr-tools generation is fine; mocking the NDK class spares us the
// constructor's WebCrypto dependency in node tests.
vi.mock('@nostr-dev-kit/ndk', () => {
  return {
    NDKPrivateKeySigner: class {
      constructor(public hex: string) {}
      async blockUntilReady() {
        return { pubkey: `pub:${this.hex.slice(0, 8)}` };
      }
    }
  };
});

import { generateSecretKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { createNsecSigner } from './nsec.js';
import { SignerError } from './types.js';

describe('createNsecSigner', () => {
  it('accepts a bech32 nsec1 string', async () => {
    const sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    const signer = await createNsecSigner(nsec);
    expect(signer.kind).toBe('nsec');
    expect(signer.pubkey.startsWith('pub:')).toBe(true);
  });

  it('accepts a 64-char hex string (case-insensitive)', async () => {
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const signer = await createNsecSigner(hex.toUpperCase());
    expect(signer.kind).toBe('nsec');
  });

  it('rejects an npub (it is the wrong half of the keypair)', async () => {
    const sk = generateSecretKey();
    const npub = nip19.npubEncode(bytesToHex(sk));
    await expect(createNsecSigner(npub)).rejects.toThrow(SignerError);
  });

  it('rejects gibberish with a clear error message', async () => {
    await expect(createNsecSigner('not-a-key')).rejects.toThrow(/nsec1.*hex/i);
  });

  it('rejects hex of the wrong length', async () => {
    await expect(createNsecSigner('00ff')).rejects.toThrow(SignerError);
  });

  it('trims whitespace before decoding', async () => {
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const signer = await createNsecSigner(`   ${hex}\n`);
    expect(signer.kind).toBe('nsec');
  });
});
