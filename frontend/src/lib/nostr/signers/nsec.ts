// Local nsec signer — "advanced" path in the UI.
// Persistence: the nsec hex is stashed in localStorage by the session
// store (see lib/stores/session.ts) so sign-in survives reload + tab
// close until the user explicitly hits "sign out". Server still never
// sees it. Trade-off: any malicious browser extension that reads
// localStorage can grab the nsec — that's the cost of "stay signed in".

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
