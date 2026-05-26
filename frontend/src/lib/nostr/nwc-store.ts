// NIP-47 Nostr Wallet Connect — connection store for the website.
//
// Mirrors browser-extension/src/lib/nwc-store.ts: same connection shape
// and same principle: the NWC app secret is a spending credential, so new
// records are encrypted at rest. The website derives a local AES key from
// the current in-memory nsec session. If the user is using NIP-07 without a
// local nsec, site-side NWC cannot be persisted safely; the extension wallet
// bridge should be used instead.
//
//   - localStorage instead of chrome.storage.local
//   - SSR guard via $app/environment so SvelteKit pre-render doesn't
//     touch the browser-only API
//
// One connection per browser profile. Schema is opaque to callers; use
// parseNwcUri / loadNwc / saveNwc / clearNwc instead of poking at
// localStorage directly.
//
// Cross-codebase note: when the standalone iOS / Android app lands,
// it'll consume this module via the SvelteKit-as-Capacitor wrapper
// rather than reimplementing — same browser localStorage semantics
// inside the WKWebView. The browser-extension's chrome.storage.local
// variant stays separate because chrome.storage.* APIs only exist
// inside extension contexts.

import { browser } from '$app/environment';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes } from '@noble/hashes/utils';
import { currentSession } from '$lib/stores/session';
import { fetchSyncedNwc, publishSyncedNwc } from './nwc-sync.js';

const KEY = 'deepmarks-nwc';
const CURRENT_SCHEMA_VERSION = 2;
const IV_BYTES = 12;

export interface NwcConnection {
  /** Wallet's pubkey (hex). All NWC requests are encrypted to this. */
  walletPubkey: string;
  /** Relay URL the wallet listens on (single relay per connection). */
  relayUrl: string;
  /** Hex-encoded 32-byte secret minted by the wallet for this app.
   *  Acts as the app's identity for the NWC channel — we sign the
   *  kind:23194 request with it. NEVER the user's main nsec. */
  appSecret: string;
  /** Optional lightning address the wallet wants payments routed to.
   *  Surfaced in some implementations but not required for pay_invoice. */
  lud16?: string;
  /** When the user pasted the URI. */
  connectedAt: number;
}

interface EncryptedNwcConnection {
  schemaVersion: 2;
  encrypted: true;
  keySource: 'session-nsec';
  walletPubkey: string;
  relayUrl: string;
  lud16?: string;
  connectedAt: number;
  appSecretBlob: {
    ciphertextB64: string;
    ivB64: string;
    cipher: 'aes-gcm-256';
  };
}

type StoredNwcConnection = NwcConnection | EncryptedNwcConnection;

export class NwcLockedError extends Error {
  constructor(message = 'Unlock with a passkey/recovery key before using this site wallet, or use the Deepmarks extension wallet bridge') {
    super(message);
    this.name = 'NwcLockedError';
  }
}

/**
 * Parse a `nostr+walletconnect://` URI into a connection record.
 * Throws on malformed input — callers should surface the error message.
 *
 * Tolerant of two flavors found in the wild:
 *   - `nostr+walletconnect://…` (current spec)
 *   - `nostrwalletconnect:…`    (older Alby exports)
 * And of `://` vs `:` separators (some wallets emit one, some the other).
 */
export function parseNwcUri(uri: string): NwcConnection {
  const trimmed = uri.trim();
  const stripped = trimmed
    .replace(/^nostr\+walletconnect:(\/\/)?/i, '')
    .replace(/^nostrwalletconnect:(\/\/)?/i, '');
  if (stripped === trimmed) {
    throw new Error('not an NWC URI — expected nostr+walletconnect://…');
  }
  const [pubkeyPart, queryPart] = stripped.split('?');
  if (!pubkeyPart || !queryPart) {
    throw new Error('NWC URI missing pubkey or query string');
  }
  const walletPubkey = pubkeyPart.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error('NWC wallet pubkey must be 64 hex chars');
  }
  const params = new URLSearchParams(queryPart);
  const relayUrl = params.get('relay');
  const appSecret = params.get('secret');
  if (!relayUrl) throw new Error('NWC URI missing relay parameter');
  if (!/^wss?:\/\//i.test(relayUrl)) throw new Error('NWC relay must be ws:// or wss://');
  if (!appSecret || !/^[0-9a-f]{64}$/i.test(appSecret)) {
    throw new Error('NWC URI missing or invalid 64-hex secret');
  }
  return {
    walletPubkey,
    relayUrl,
    appSecret: appSecret.toLowerCase(),
    lud16: params.get('lud16') ?? undefined,
    connectedAt: Math.floor(Date.now() / 1000),
  };
}

export async function loadNwc(): Promise<NwcConnection | null> {
  if (!browser) return null;
  const synced = await loadSyncedNwcBestEffort();
  if (synced.kind === 'deleted') {
    clearLocalNwc();
    return null;
  }
  if (synced.kind === 'connected') {
    await saveNwcLocallyBestEffort(synced.connection);
    return synced.connection;
  }
  const stored = readStoredNwc();
  if (!stored) return null;
  if (isEncryptedNwc(stored)) return decryptStoredNwc(stored);

  // Legacy plaintext record. Migrate only when a local nsec-backed session
  // is available; otherwise refuse to use a persisted spending secret that
  // is sitting unencrypted in localStorage.
  const key = await deriveSessionNwcKey();
  if (!key) throw new NwcLockedError('Reconnect NWC after unlocking with a passkey/recovery key, or use the Deepmarks extension wallet bridge');
  await saveNwcWithKey(stored, key);
  return stored;
}

export async function saveNwc(conn: NwcConnection): Promise<void> {
  if (!browser) return;
  const state = currentSession();
  let savedLocal = false;
  let syncedRemote = false;
  let lastError: unknown;

  const key = await deriveSessionNwcKey();
  if (key) {
    await saveNwcWithKey(conn, key);
    savedLocal = true;
  }

  if (state.pubkey && state.signer) {
    try {
      await publishSyncedNwc(conn, state.pubkey);
      syncedRemote = true;
    } catch (e) {
      lastError = e;
    }
  }

  if (!savedLocal && !syncedRemote) {
    if (lastError instanceof Error) throw lastError;
    throw new NwcLockedError('Sign in with a passkey, recovery key, or signer before saving NWC');
  }
}

async function saveNwcWithKey(conn: NwcConnection, key: CryptoKey): Promise<void> {
  try {
    localStorage.setItem(KEY, JSON.stringify(await encryptConnection(conn, key)));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export async function clearNwc(): Promise<void> {
  if (!browser) return;
  const state = currentSession();
  if (state.pubkey && state.signer) {
    await publishSyncedNwc(null, state.pubkey).catch(() => undefined);
  }
  clearLocalNwc();
}

function clearLocalNwc(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

async function loadSyncedNwcBestEffort(): Promise<
  | { kind: 'missing' }
  | { kind: 'deleted' }
  | { kind: 'connected'; connection: NwcConnection }
> {
  const state = currentSession();
  if (!state.pubkey || !state.signer) return { kind: 'missing' };
  try {
    const synced = await fetchSyncedNwc(state.pubkey);
    if (!synced) return { kind: 'missing' };
    if (synced.deletedAt) return { kind: 'deleted' };
    if (synced.connection) return { kind: 'connected', connection: synced.connection };
  } catch {
    return { kind: 'missing' };
  }
  return { kind: 'missing' };
}

async function saveNwcLocallyBestEffort(conn: NwcConnection): Promise<void> {
  const key = await deriveSessionNwcKey();
  if (!key) return;
  await saveNwcWithKey(conn, key);
}

export async function isNwcConnected(): Promise<boolean> {
  return !!(await loadNwc());
}

function readStoredNwc(): StoredNwcConnection | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (isEncryptedNwc(parsed)) return parsed;
  if (isPlainNwc(parsed)) return parsed;
  return null;
}

function isPlainNwc(value: object): value is NwcConnection {
  const v = value as Partial<NwcConnection>;
  return (
    typeof v.walletPubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.walletPubkey) &&
    typeof v.relayUrl === 'string' &&
    /^wss?:\/\//i.test(v.relayUrl) &&
    typeof v.appSecret === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.appSecret)
  );
}

function isEncryptedNwc(value: object): value is EncryptedNwcConnection {
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === CURRENT_SCHEMA_VERSION &&
    v.encrypted === true &&
    v.keySource === 'session-nsec' &&
    typeof v.walletPubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.walletPubkey) &&
    typeof v.relayUrl === 'string' &&
    /^wss?:\/\//i.test(v.relayUrl) &&
    typeof v.appSecretBlob === 'object' &&
    v.appSecretBlob !== null
  );
}

async function deriveSessionNwcKey(): Promise<CryptoKey | null> {
  const nsecHex = currentSession().signer?.nsecHex;
  if (!nsecHex || !/^[0-9a-f]{64}$/i.test(nsecHex)) return null;
  const material = new Uint8Array([
    ...new TextEncoder().encode('deepmarks:site-nwc:v1:'),
    ...hexToBytes(nsecHex),
  ]);
  return crypto.subtle.importKey(
    'raw',
    sha256(material) as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function decryptStoredNwc(record: EncryptedNwcConnection): Promise<NwcConnection> {
  const key = await deriveSessionNwcKey();
  if (!key) throw new NwcLockedError();
  const appSecret = await decryptTextWithKey(record.appSecretBlob, key);
  if (!/^[0-9a-f]{64}$/i.test(appSecret)) throw new Error('encrypted NWC secret is corrupt');
  return {
    walletPubkey: record.walletPubkey,
    relayUrl: record.relayUrl,
    appSecret: appSecret.toLowerCase(),
    lud16: record.lud16,
    connectedAt: record.connectedAt,
  };
}

async function encryptConnection(conn: NwcConnection, key: CryptoKey): Promise<EncryptedNwcConnection> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    encrypted: true,
    keySource: 'session-nsec',
    walletPubkey: conn.walletPubkey,
    relayUrl: conn.relayUrl,
    lud16: conn.lud16,
    connectedAt: conn.connectedAt,
    appSecretBlob: await encryptTextWithKey(conn.appSecret, key),
  };
}

async function encryptTextWithKey(
  plaintext: string,
  key: CryptoKey,
): Promise<EncryptedNwcConnection['appSecretBlob']> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return {
    ciphertextB64: bytesToB64(new Uint8Array(ctBuf)),
    ivB64: bytesToB64(iv),
    cipher: 'aes-gcm-256',
  };
}

async function decryptTextWithKey(
  blob: EncryptedNwcConnection['appSecretBlob'],
  key: CryptoKey,
): Promise<string> {
  if (blob.cipher !== 'aes-gcm-256') throw new Error('unsupported encrypted NWC payload');
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(blob.ivB64) as BufferSource },
    key,
    b64ToBytes(blob.ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(ptBuf);
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
