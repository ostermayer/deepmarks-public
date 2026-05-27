import {
  NDKRelay,
  NDKUser,
  type NDKEncryptionScheme,
  type NDKSigner,
  type NostrEvent,
} from '@nostr-dev-kit/ndk';
import type NDK from '@nostr-dev-kit/ndk';
import {
  callAndroidSigner,
  connectAndroidSigner,
  listAndroidSigners,
  type ExternalAndroidSignerAccount,
  type ExternalAndroidSignerApp,
} from '$lib/mobile/secure-store';
import { SignerError, type ResolvedSigner } from './types.js';

type SupportedEncryption = 'nip04' | 'nip44';
export type AndroidSignerApp = ExternalAndroidSignerApp;

export interface AndroidSignerPayload extends ExternalAndroidSignerAccount {
  type: 'android-nip55';
}

const DEFAULT_ANDROID_SIGNER_PERMISSIONS = [
  'get_public_key',
  'sign_event:0',
  'sign_event:1',
  'sign_event:3',
  'sign_event:5',
  'sign_event:9734',
  'sign_event:10000',
  'sign_event:10002',
  'sign_event:10003',
  'sign_event:22242',
  'sign_event:24242',
  'sign_event:27235',
  'sign_event:30000',
  'sign_event:30003',
  'sign_event:39701',
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
].join(',');

export async function listAvailableAndroidSigners(): Promise<AndroidSignerApp[]> {
  return listAndroidSigners();
}

export async function createAndroidSigner(options: { packageName?: string } = {}): Promise<ResolvedSigner> {
  let account: ExternalAndroidSignerAccount;
  try {
    account = await connectAndroidSigner({
      packageName: options.packageName,
      permissions: DEFAULT_ANDROID_SIGNER_PERMISSIONS,
    });
  } catch (e) {
    throw androidSignerError(e, 'Connect an Android signer such as Amber or Primal first.');
  }
  return resolvedFromAccount(account);
}

export async function createAndroidSignerFromPayload(payload: string): Promise<ResolvedSigner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new SignerError('Android signer session is invalid.', 'invalid-key');
  }
  if (!isAndroidSignerPayload(parsed)) {
    throw new SignerError('Android signer session is invalid.', 'invalid-key');
  }
  return resolvedFromAccount(parsed);
}

function resolvedFromAccount(account: ExternalAndroidSignerAccount): ResolvedSigner {
  const ndk = new AndroidNip55Signer(account);
  return { kind: 'android', pubkey: account.pubkey, ndk };
}

function isAndroidSignerPayload(value: unknown): value is AndroidSignerPayload {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    raw.type === 'android-nip55' &&
    typeof raw.pubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(raw.pubkey) &&
    typeof raw.packageName === 'string' &&
    raw.packageName.length > 0 &&
    (raw.appName === undefined || typeof raw.appName === 'string')
  );
}

class AndroidNip55Signer implements NDKSigner {
  private readonly account: ExternalAndroidSignerAccount;
  private readonly readyUser: NDKUser;

  constructor(account: ExternalAndroidSignerAccount) {
    this.account = {
      pubkey: account.pubkey.toLowerCase(),
      packageName: account.packageName,
      appName: account.appName,
    };
    this.readyUser = new NDKUser({ pubkey: this.account.pubkey });
  }

  get pubkey(): string {
    return this.account.pubkey;
  }

  blockUntilReady(): Promise<NDKUser> {
    return Promise.resolve(this.readyUser);
  }

  user(): Promise<NDKUser> {
    return Promise.resolve(this.readyUser);
  }

  get userSync(): NDKUser {
    return this.readyUser;
  }

  async sign(event: NostrEvent): Promise<string> {
    const result = await callSigner({
      packageName: this.account.packageName,
      type: 'sign_event',
      content: JSON.stringify(eventTemplate(event, this.account.pubkey)),
      currentUser: this.account.pubkey,
      id: typeof event.id === 'string' ? event.id : undefined,
      returnType: 'event',
    });
    const signature = signatureFromResult(result.result, result.event);
    if (!signature) throw new Error('Android signer did not return a signature');
    return signature;
  }

  relays(_ndk?: NDK): Promise<NDKRelay[]> {
    return Promise.resolve([]);
  }

  async encryptionEnabled(scheme?: NDKEncryptionScheme): Promise<NDKEncryptionScheme[]> {
    const enabled: NDKEncryptionScheme[] = [];
    if (!scheme || scheme === 'nip04') enabled.push('nip04');
    if (!scheme || scheme === 'nip44') enabled.push('nip44');
    return enabled;
  }

  async encrypt(recipient: NDKUser, value: string, scheme: NDKEncryptionScheme = 'nip04'): Promise<string> {
    if (!isSupportedEncryption(scheme)) {
      throw new Error(`${scheme} encryption is not available from Android signers`);
    }
    const result = await callSigner({
      packageName: this.account.packageName,
      type: scheme === 'nip44' ? 'nip44_encrypt' : 'nip04_encrypt',
      content: value,
      currentUser: this.account.pubkey,
      pubkey: recipient.pubkey,
    });
    return result.result;
  }

  async decrypt(sender: NDKUser, value: string, scheme: NDKEncryptionScheme = 'nip04'): Promise<string> {
    if (!isSupportedEncryption(scheme)) {
      throw new Error(`${scheme} encryption is not available from Android signers`);
    }
    const result = await callSigner({
      packageName: this.account.packageName,
      type: scheme === 'nip44' ? 'nip44_decrypt' : 'nip04_decrypt',
      content: value,
      currentUser: this.account.pubkey,
      pubkey: sender.pubkey,
    });
    return result.result;
  }

  toPayload(): string {
    return JSON.stringify({
      type: 'android-nip55',
      pubkey: this.account.pubkey,
      packageName: this.account.packageName,
      appName: this.account.appName,
    } satisfies AndroidSignerPayload);
  }
}

function eventTemplate(event: NostrEvent, pubkey: string): Record<string, unknown> {
  return {
    kind: Number.isInteger(event.kind) ? event.kind : 1,
    pubkey,
    created_at: Number.isInteger(event.created_at) ? event.created_at : Math.floor(Date.now() / 1000),
    tags: Array.isArray(event.tags) ? event.tags : [],
    content: typeof event.content === 'string' ? event.content : '',
  };
}

function signatureFromResult(result: string, eventJson?: string): string {
  if (/^[0-9a-f]{128}$/i.test(result)) return result.toLowerCase();
  if (eventJson) {
    try {
      const parsed = JSON.parse(eventJson) as { sig?: unknown };
      if (typeof parsed.sig === 'string' && /^[0-9a-f]{128}$/i.test(parsed.sig)) {
        return parsed.sig.toLowerCase();
      }
    } catch {
      // Fall through to the result parser below.
    }
  }
  try {
    const parsed = JSON.parse(result) as { sig?: unknown };
    if (typeof parsed.sig === 'string' && /^[0-9a-f]{128}$/i.test(parsed.sig)) {
      return parsed.sig.toLowerCase();
    }
  } catch {
    // Plain result was not JSON.
  }
  return '';
}

async function callSigner(options: Parameters<typeof callAndroidSigner>[0]) {
  try {
    return await callAndroidSigner(options);
  } catch (e) {
    throw androidSignerError(e, 'Android signer request failed.');
  }
}

function androidSignerError(error: unknown, fallback: string): SignerError {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (normalized.includes('cancel') || normalized.includes('reject') || normalized.includes('denied')) {
    return new SignerError(message || 'Android signer request was rejected.', 'user-rejected');
  }
  if (normalized.includes('no android signer') || normalized.includes('no app can handle')) {
    return new SignerError('Install Amber, Primal, or another Android Nostr signer and try again.', 'no-signer');
  }
  return new SignerError(message || fallback, 'transport');
}

function isSupportedEncryption(scheme: NDKEncryptionScheme): scheme is SupportedEncryption {
  return scheme === 'nip04' || scheme === 'nip44';
}
