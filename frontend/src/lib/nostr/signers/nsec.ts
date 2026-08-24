// Local nsec signer — "advanced" path in the UI.
// Persistence is owned by lib/stores/session.ts. User-facing flows keep
// nsec sessions can opt into localStorage persistence for usability; the
// UI steers users toward browser extensions for stronger key isolation.

import { NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';
import { SignerError, type ResolvedSigner } from './types.js';

function decodeNsecToHex(input: string): string {
  // Strip whitespace plus the invisible characters phone messengers smuggle
  // into copied text (zero-width space/joiners, word-joiner, BOM) — trim()
  // alone leaves those and the paste then looks valid but fails to decode.
  const trimmed = input.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  // bech32 also permits an ALL-UPPERCASE encoding (QR alphanumeric mode
  // produces it) — normalize before sniffing the prefix. Mixed case is
  // invalid bech32 and fails decode below with the friendly error.
  const candidate = trimmed.toLowerCase();
  if (candidate.startsWith('nsec1')) {
    let data: Uint8Array;
    try {
      const decoded = nip19.decode(candidate);
      if (decoded.type !== 'nsec') throw new Error('not an nsec');
      data = decoded.data;
    } catch {
      // Never propagate nip19's own error: its checksum message echoes the
      // pasted SECRET, and the login page renders signer error messages
      // into the DOM (2026-08-22 review finding).
      throw new SignerError('Not a valid nsec — check for typos.', 'invalid-key');
    }
    return bytesToHex(data);
  }
  if (/^[0-9a-f]{64}$/.test(candidate)) return candidate;
  throw new SignerError('Expected nsec1… or 64-char hex secret.', 'invalid-key');
}

export async function createNsecSigner(nsecOrHex: string): Promise<ResolvedSigner & { nsecHex: string }> {
  const hex = decodeNsecToHex(nsecOrHex);
  let ndk: NDKPrivateKeySigner;
  let user: Awaited<ReturnType<NDKPrivateKeySigner['blockUntilReady']>>;
  try {
    ndk = new NDKPrivateKeySigner(hex);
    user = await ndk.blockUntilReady();
  } catch {
    // 64 hex chars that are not a valid secp256k1 scalar (all zeros, ≥ the
    // curve order) make noble throw a raw Error inside the constructor —
    // surface the same friendly SignerError instead of library internals.
    throw new SignerError('That is not a valid secp256k1 secret key.', 'invalid-key');
  }
  // Attach the hex so settings can offer "reveal my nsec" and
  // "add passkey on this device" without asking the user to re-paste.
  // Stays in JS memory for the tab lifetime; cleared on logout.
  return { kind: 'nsec', pubkey: user.pubkey, ndk, nsecHex: hex };
}
