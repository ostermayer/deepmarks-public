// Signer abstraction. NDK ships first-class implementations for every method
// we need (NIP-07, NIP-46, raw private key) — we wrap them in a tagged union
// so the UI layer can render the right copy / icon for each path without
// caring about the underlying class.

import type { NDKSigner } from '@nostr-dev-kit/ndk';

export type SignerKind = 'nip07' | 'nip46' | 'nsec';

export interface ResolvedSigner {
  kind: SignerKind;
  pubkey: string;
  ndk: NDKSigner;
  /** Hex-encoded private key, present only on `kind === 'nsec'`. Kept
   *  in memory for the tab lifetime so settings can offer "reveal my
   *  nsec" and "add passkey on this device" without re-prompting. */
  nsecHex?: string;
}

export class SignerError extends Error {
  constructor(
    message: string,
    public code:
      | 'no-signer'
      | 'user-rejected'
      | 'unsupported'
      | 'invalid-key'
      | 'transport'
  ) {
    super(message);
    this.name = 'SignerError';
  }
}
