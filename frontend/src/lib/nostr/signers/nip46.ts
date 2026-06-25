// NIP-46 — remote signer (Deepmarks mobile, Amber, nsec.app, custom).
// Bunker URI sign-in consumes an existing `bunker://…` token.
// Nostr Connect sign-in creates a `nostrconnect://…` QR/deep link that
// the phone app scans/opens, then NDK completes the handshake.

import { NDKNip46Signer } from '@nostr-dev-kit/ndk';
import QRCode from 'qrcode';
import { config } from '$lib/config.js';
import { getNdk } from '../ndk.js';
import { SignerError, type ResolvedSigner } from './types.js';

const DEFAULT_NOSTR_CONNECT_TIMEOUT_MS = 180_000;
const RESTORE_TIMEOUT_MS = 8_000;

const DEEPMARKS_NIP46_PERMS = [
  'sign_event',
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
] as const;

interface NostrConnectOptions {
  relay?: string;
  name?: string;
  url?: string;
  image?: string;
  perms?: readonly string[];
}

export interface Nip46PairingSession {
  uri: string;
  qrDataUrl: string;
  relay: string;
  waitForSigner(timeoutMs?: number): Promise<ResolvedSigner>;
  stop(): void;
}

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

export async function createNip46PairingSession(
  options: NostrConnectOptions = {},
): Promise<Nip46PairingSession> {
  const ndk = getNdk();
  const relay = options.relay ?? config.deepmarksRelay;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://deepmarks.org';
  const signer = NDKNip46Signer.nostrconnect(ndk, relay, undefined, {
    name: options.name ?? 'Deepmarks Web',
    url: options.url ?? origin,
    image: options.image,
    perms: (options.perms ?? DEEPMARKS_NIP46_PERMS).join(','),
  });
  const uri = signer.nostrConnectUri;
  if (!uri) {
    throw new SignerError('Could not create a Nostr Connect pairing URI.', 'transport');
  }
  const qrDataUrl = await QRCode.toDataURL(uri, {
    width: 260,
    margin: 1,
    color: {
      dark: '#123452',
      light: '#ffffff',
    },
  });

  return {
    uri,
    qrDataUrl,
    relay,
    waitForSigner: async (timeoutMs = DEFAULT_NOSTR_CONNECT_TIMEOUT_MS) => {
      try {
        const user = await withTimeout(signer.blockUntilReady(), timeoutMs, 'phone signer did not respond in time');
        return { kind: 'nip46', pubkey: user.pubkey, ndk: signer };
      } catch (e) {
        throw new SignerError(`Nostr Connect failed: ${(e as Error).message}`, 'transport');
      }
    },
    stop: () => signer.stop(),
  };
}

export async function createNip46SignerFromPayload(payload: string): Promise<ResolvedSigner> {
  const ndk = getNdk();
  try {
    const signer = await NDKNip46Signer.fromPayload(payload, ndk);
    const user = await withTimeout(
      signer.blockUntilReady(),
      RESTORE_TIMEOUT_MS,
      'remote signer is not available',
    );
    return { kind: 'nip46', pubkey: user.pubkey, ndk: signer };
  } catch (e) {
    throw new SignerError(
      `Could not restore remote signer: ${(e as Error).message}`,
      'transport',
    );
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
