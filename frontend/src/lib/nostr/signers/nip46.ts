// NIP-46 — remote bunker signer (Primal mobile, nsec.app, custom).
// User scans a `bunker://…` QR or pastes the URI; their phone/server signs.
// NDK ships NDKNip46Signer which handles the full handshake.

import { NDKNip46Signer } from '@nostr-dev-kit/ndk';
import { getNdk } from '../ndk.js';
import { SignerError, type ResolvedSigner } from './types.js';

export async function createNip46Signer(bunkerUri: string): Promise<ResolvedSigner> {
  const trimmed = bunkerUri.trim();
  if (!trimmed.startsWith('bunker://')) {
    throw new SignerError(
      'Bunker URI must start with bunker://. Scan the QR from your remote signer app.',
      'invalid-key'
    );
  }
  const ndk = getNdk();
  try {
    // NDKNip46Signer parses the bunker URI, opens the relay, sends the connect
    // request, and resolves once the remote signer acks.
    const signer = NDKNip46Signer.bunker(ndk, trimmed);
    const user = await signer.blockUntilReady();
    return { kind: 'nip46', pubkey: user.pubkey, ndk: signer };
  } catch (e) {
    throw new SignerError(
      `Bunker handshake failed: ${(e as Error).message}`,
      'transport'
    );
  }
}
