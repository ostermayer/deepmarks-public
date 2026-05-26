// Local nsec signer — "advanced" path in the UI.
// Persistence is owned by lib/stores/session.ts. User-facing flows keep
// nsec sessions can opt into localStorage persistence for usability; the
// UI steers users toward browser extensions for stronger key isolation.

import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { SignerError, type ResolvedSigner } from './types.js';

function decodeNsecToHex(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') {
      throw new SignerError('Not a valid nsec.', 'invalid-key');
    }
    return bytesToHex(decoded.data);
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  throw new SignerError('Expected nsec1… or 64-char hex secret.', 'invalid-key');
}

export async function createNsecSigner(nsecOrHex: string): Promise<ResolvedSigner & { nsecHex: string }> {
  const hex = decodeNsecToHex(nsecOrHex);
  const ndk = new NDKPrivateKeySigner(hex);
  const user = await ndk.blockUntilReady();
  // Attach the hex so settings can offer "reveal my nsec" and
  // "add passkey on this device" without asking the user to re-paste.
  // Stays in JS memory for the tab lifetime; cleared on logout.
  return { kind: 'nsec', pubkey: user.pubkey, ndk, nsecHex: hex };
}
