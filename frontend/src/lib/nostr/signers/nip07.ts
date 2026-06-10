// NIP-07 — browser extension signer (Deepmarks, Alby, nos2x, Flamingo).
// Most secure path; the page never touches the secret key.

import {
  NDKNip07Signer,
  NDKRelay,
  NDKUser,
  type NDKEncryptionScheme,
  type NDKSigner,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
import type NDK from '@nostr-dev-kit/ndk';
import { SignerError, type ResolvedSigner } from './types.js';

type RelayMap = Record<string, { read: boolean; write: boolean }>;
type Nip07Provider = NonNullable<Window['nostr']>;
type SupportedEncryption = 'nip04' | 'nip44';

export function isNip07Available(): boolean {
  return typeof window !== 'undefined' && !!window.nostr;
}

export function getDeepmarksNip07Provider(): Nip07Provider | null {
  if (typeof window === 'undefined') return null;
  if (window.deepmarks?.nostr) return window.deepmarks.nostr;
  if (window.nostr?.__deepmarks || window.nostr?.deepmarks?.extension) return window.nostr;
  return null;
}

export function isDeepmarksExtensionAvailable(): boolean {
  return getDeepmarksNip07Provider() !== null;
}

export async function createNip07Signer(): Promise<ResolvedSigner> {
  if (!isNip07Available()) {
    throw new SignerError(
      'Install the Deepmarks extension and reload.',
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

export async function createDeepmarksExtensionSigner(): Promise<ResolvedSigner> {
  const provider = getDeepmarksNip07Provider();
  if (!provider) {
    throw new SignerError(
      'Install the Deepmarks extension and reload.',
      'no-signer'
    );
  }
  const ndk = new DirectNip07Signer(provider);
  try {
    const user = await ndk.blockUntilReady();
    return { kind: 'nip07', pubkey: user.pubkey, ndk };
  } catch (e) {
    throw new SignerError(`Extension refused: ${(e as Error).message}`, 'user-rejected');
  }
}

class DirectNip07Signer implements NDKSigner {
  private userPromise: Promise<NDKUser> | undefined;
  private readyUser: NDKUser | undefined;
  private readyPubkey: string | undefined;

  constructor(private readonly provider: Nip07Provider) {}

  get pubkey(): string {
    if (!this.readyPubkey) throw new Error('Not ready');
    return this.readyPubkey;
  }

  async blockUntilReady(): Promise<NDKUser> {
    const pubkey = await this.provider.getPublicKey();
    if (!pubkey) throw new Error('User rejected access');
    this.readyPubkey = pubkey;
    this.readyUser = new NDKUser({ pubkey });
    return this.readyUser;
  }

  user(): Promise<NDKUser> {
    if (!this.userPromise) this.userPromise = this.blockUntilReady();
    return this.userPromise;
  }

  get userSync(): NDKUser {
    if (!this.readyUser) throw new Error('User not ready');
    return this.readyUser;
  }

  async sign(event: NostrEvent): Promise<string> {
    const signed = await this.provider.signEvent(event);
    if (!signed?.sig) throw new Error('Failed to sign event');
    return signed.sig;
  }

  async relays(ndk?: NDK): Promise<NDKRelay[]> {
    if (!ndk) return [];
    const relays: RelayMap = (await this.provider.getRelays?.()) ?? {};
    return Object.entries(relays)
      .filter(([, policy]) => policy.read && policy.write)
      .map(([url]) => new NDKRelay(url, ndk.relayAuthDefaultPolicy, ndk));
  }

  async encryptionEnabled(scheme?: NDKEncryptionScheme): Promise<NDKEncryptionScheme[]> {
    const enabled: NDKEncryptionScheme[] = [];
    if ((!scheme || scheme === 'nip04') && this.provider.nip04) enabled.push('nip04');
    if ((!scheme || scheme === 'nip44') && this.provider.nip44) enabled.push('nip44');
    return enabled;
  }

  async encrypt(recipient: NDKUser, value: string, scheme: NDKEncryptionScheme = 'nip04'): Promise<string> {
    const method = this.encryptionProvider(scheme);
    return method.encrypt(recipient.pubkey, value);
  }

  async decrypt(sender: NDKUser, value: string, scheme: NDKEncryptionScheme = 'nip04'): Promise<string> {
    const method = this.encryptionProvider(scheme);
    return method.decrypt(sender.pubkey, value);
  }

  toPayload(): string {
    return JSON.stringify({ type: 'deepmarks-nip07', payload: '' });
  }

  private encryptionProvider(scheme: NDKEncryptionScheme) {
    if (!isSupportedEncryption(scheme)) {
      throw new Error(`${scheme} encryption is not available from your browser extension`);
    }
    const provider = this.provider[scheme];
    if (!provider) {
      throw new Error(`${scheme} encryption is not available from your browser extension`);
    }
    return provider;
  }
}

function isSupportedEncryption(scheme: NDKEncryptionScheme): scheme is SupportedEncryption {
  return scheme === 'nip04' || scheme === 'nip44';
}
