// NWC (NIP-47 / Nostr Wallet Connect) connection store.
//
// One connection per browser profile; chrome.storage.local-backed so
// it survives popup close + browser restart. The spending secret is
// encrypted at rest with the same password-derived account key that
// protects the user's nsec. Sites can request WebLN payments, but the
// NWC secret is never exposed to the page or stored as new plaintext.
//
// Schema is opaque to callers: use parseNwcUri / loadNwc / saveNwc /
// clearNwc instead of poking at storage directly.

import {
  decryptTextWithKey,
  encryptTextWithKey,
  type EncryptedPayload,
} from './nsec-crypto.js';
import {
  getCachedAccountEncryptionKey,
  nsecStore,
} from './nsec-store.js';

const KEY = 'deepmarks-nwc';
const CURRENT_SCHEMA_VERSION = 2;

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
  keySource: 'deepmarks-account';
  walletPubkey: string;
  relayUrl: string;
  lud16?: string;
  connectedAt: number;
  appSecretBlob: EncryptedPayload;
}

type StoredNwcConnection = NwcConnection | EncryptedNwcConnection;

export class NwcLockedError extends Error {
  constructor(message = 'Deepmarks wallet connection is locked — unlock your extension password first') {
    super(message);
    this.name = 'NwcLockedError';
  }
}

/** Parse a `nostr+walletconnect://` URI into a connection record.
 *  Throws on malformed input — callers should surface the error message. */
export function parseNwcUri(uri: string): NwcConnection {
  const trimmed = uri.trim();
  // Both `nostr+walletconnect:` and `nostrwalletconnect:` schemes appear
  // in the wild; older Alby exports omit the +. Accept either. Some
  // wallets emit the URI with `://` and some without — parse both.
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
  const stored = await readStoredNwc();
  if (!stored) return null;
  if (isEncryptedNwc(stored)) return decryptStoredNwc(stored);

  // Legacy plaintext record. If the account is protected and unlocked,
  // migrate it before returning it. If the protected account is locked,
  // refuse to use the plaintext secret so payments cannot bypass the
  // user's password choice after this upgrade.
  const account = await nsecStore.getState();
  if (account.protected) {
    const key = await getCachedAccountEncryptionKey();
    if (!key) throw new NwcLockedError();
    await saveNwcWithKey(stored, key);
  }
  return stored;
}

export async function saveNwc(conn: NwcConnection): Promise<void> {
  const key = await getCachedAccountEncryptionKey();
  if (!key) {
    throw new NwcLockedError('Set or unlock your Deepmarks password before connecting NWC');
  }
  await saveNwcWithKey(conn, key);
}

export async function saveNwcWithKey(conn: NwcConnection, key: CryptoKey): Promise<void> {
  await chrome.storage.local.set({ [KEY]: await encryptConnection(conn, key) });
}

export async function clearNwc(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** Used by legacy set-password migration and password rotation. */
export async function exportNwcForRekey(key?: CryptoKey): Promise<NwcConnection | null> {
  const stored = await readStoredNwc();
  if (!stored) return null;
  if (!isEncryptedNwc(stored)) return stored;
  if (!key) throw new NwcLockedError();
  return decryptStoredNwcWithKey(stored, key);
}

export async function migrateNwcToEncrypted(key: CryptoKey): Promise<void> {
  const conn = await exportNwcForRekey(key);
  if (!conn) return;
  await saveNwcWithKey(conn, key);
}

async function readStoredNwc(): Promise<StoredNwcConnection | null> {
  const raw = await chrome.storage.local.get(KEY);
  const value = raw[KEY] as unknown;
  if (!value || typeof value !== 'object') return null;
  if (isEncryptedNwc(value)) return value;
  if (isPlainNwc(value)) return value;
  return null;
}

function isPlainNwc(value: object): value is NwcConnection {
  const v = value as Record<string, unknown>;
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
    v.keySource === 'deepmarks-account' &&
    typeof v.walletPubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(v.walletPubkey) &&
    typeof v.relayUrl === 'string' &&
    /^wss?:\/\//i.test(v.relayUrl) &&
    typeof v.appSecretBlob === 'object' &&
    v.appSecretBlob !== null
  );
}

async function decryptStoredNwc(record: EncryptedNwcConnection): Promise<NwcConnection> {
  const key = await getCachedAccountEncryptionKey();
  if (!key) throw new NwcLockedError();
  return decryptStoredNwcWithKey(record, key);
}

async function decryptStoredNwcWithKey(
  record: EncryptedNwcConnection,
  key: CryptoKey,
): Promise<NwcConnection> {
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

async function encryptConnection(
  conn: NwcConnection,
  key: CryptoKey,
): Promise<EncryptedNwcConnection> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    encrypted: true,
    keySource: 'deepmarks-account',
    walletPubkey: conn.walletPubkey,
    relayUrl: conn.relayUrl,
    lud16: conn.lud16,
    connectedAt: conn.connectedAt,
    appSecretBlob: await encryptTextWithKey(conn.appSecret, key),
  };
}
