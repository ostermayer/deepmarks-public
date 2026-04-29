// NIP-07 — browser extension signer (Alby, nos2x, Flamingo).
// Most secure path; the page never touches the secret key.

import { NDKNip07Signer } from '@nostr-dev-kit/ndk';
import { SignerError, type ResolvedSigner } from './types.js';

export function isNip07Available(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

export async function createNip07Signer(): Promise<ResolvedSigner> {
  if (!isNip07Available()) {
    throw new SignerError(
      'No NIP-07 extension detected. Install Alby, nos2x, or Flamingo.',
      'no-signer'
    );
  }
  const ndk = new NDKNip07Signer();
  try {
    const user = await ndk.blockUntilReady();
    return { kind: 'nip07', pubkey: user.pubkey, ndk };
  } catch (e) {
    throw new SignerError(`Extension refused: ${(e as Error).message}`, 'user-rejected');
  }
}
