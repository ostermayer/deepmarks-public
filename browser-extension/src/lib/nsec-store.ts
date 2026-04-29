// Single facade for nsec storage. Every popup, background, and content
// script that needs the user's private key goes through this module —
// never `chrome.storage.local.get('account')` directly. Swapping
// implementations later (Safari Keychain native bridge) is then a
// one-file change here.
//
// Storage is versioned. Two record shapes are valid:
//
//   PlainAccount      — schemaVersion: 1, encrypted: false
//                       nsecHex stored in cleartext. Same posture as nos2x.
//
//   EncryptedAccount  — schemaVersion: 1, encrypted: true
//                       nsecHex encrypted with AES-GCM, key derived from
//                       the user's password via PBKDF2-SHA256. Pubkey is
//                       still plaintext so the popup can show npub etc.
//                       before unlocking.
//
// Cache layer (only relevant when account.encrypted === true):
//   - The derived key is stored in chrome.storage.session (cleared on
//     browser close) so the user enters their password once per session.
//   - If they pick "remember 30 days" the key is also mirrored into
//     chrome.storage.local with a `derivedKeyExpiresAt` timestamp.
//     On boot, expired entries get wiped before any read.

import { hexToBytes, bytesToHex } from 'nostr-tools/utils';
import { nip19, getPublicKey } from 'nostr-tools';
import {
  decryptNsecWithKey,
  decryptNsecWithPassword,
  encryptNsec,
  exportKey,
  importKey,
  deriveKeyFromExisting,
  type EncryptedBlob,
} from './nsec-crypto.js';

const STORAGE_KEY = 'deepmarks-account';
const SESSION_KEY = 'deepmarks-derived-key';
const PERSISTENT_KEY_CACHE = 'deepmarks-derived-key-cached';
const CURRENT_SCHEMA_VERSION = 1;

// ── Record shapes ─────────────────────────────────────────────────────

export interface PlainAccount {
  schemaVersion: 1;
  encrypted: false;
  nsecHex: string;
  pubkey: string;
  signedInAt: number;
}

export interface EncryptedAccount {
  schemaVersion: 1;
  encrypted: true;
  pubkey: string;
  signedInAt: number;
  blob: EncryptedBlob;
}

export type Account = PlainAccount | EncryptedAccount;

/** What callers actually want — flattened state with the secret if
 *  available, locked-flag if not. */
export interface NsecState {
  /** True when no nsec exists at all. */
  empty: boolean;
  /** True when an nsec exists but it's encrypted and we have no
   *  cached derived key. UI should route to Unlock. */
  locked: boolean;
  /** True when the stored record is password-protected (regardless
   *  of whether the key is currently cached). */
  protected: boolean;
  /** The pubkey — always available for any non-empty state. */
  pubkey: string | null;
  /** The decrypted nsec hex — only set when (empty=false, locked=false). */
  nsecHex: string | null;
  /** Unix seconds — when the nsec was first stored. */
  signedInAt: number | null;
}

export type CacheMode = 'session' | 'days30';

// ── Storage helpers ───────────────────────────────────────────────────

async function readAccount(): Promise<Account | null> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const v = raw[STORAGE_KEY] as Partial<Account> | undefined;
  if (!v || typeof v !== 'object') return null;
  if (v.encrypted === true && v.blob) return v as EncryptedAccount;
  if (v.encrypted === false && typeof v.nsecHex === 'string' && /^[0-9a-f]{64}$/i.test(v.nsecHex)) {
    return { ...v, schemaVersion: CURRENT_SCHEMA_VERSION } as PlainAccount;
  }
  return null;
}

async function writeAccount(a: Account): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: a });
}

/** Expired-cache cleanup. Run before any read so we don't return a
 *  key that's past its 30-day TTL. */
async function purgeExpiredKeyCache(): Promise<void> {
  const raw = await chrome.storage.local.get(PERSISTENT_KEY_CACHE);
  const v = raw[PERSISTENT_KEY_CACHE] as { keyB64: string; expiresAt: number } | undefined;
  if (v && v.expiresAt > Date.now()) return;
  if (v) await chrome.storage.local.remove(PERSISTENT_KEY_CACHE);
}

async function readCachedKey(): Promise<CryptoKey | null> {
  await purgeExpiredKeyCache();
  // Try session first (always-fresh).
  const session = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session;
  if (session) {
    const raw = await session.get(SESSION_KEY);
    const b64 = raw[SESSION_KEY];
    if (typeof b64 === 'string') return importKey(b64);
  }
  // Fall back to the persistent 30-day cache.
  const raw = await chrome.storage.local.get(PERSISTENT_KEY_CACHE);
  const v = raw[PERSISTENT_KEY_CACHE] as { keyB64: string; expiresAt: number } | undefined;
  if (v && v.expiresAt > Date.now()) return importKey(v.keyB64);
  return null;
}

async function writeCachedKey(key: CryptoKey, mode: CacheMode): Promise<void> {
  const b64 = await exportKey(key);
  const session = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session;
  if (session) {
    await session.set({ [SESSION_KEY]: b64 });
  }
  if (mode === 'days30') {
    await chrome.storage.local.set({
      [PERSISTENT_KEY_CACHE]: { keyB64: b64, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 },
    });
  } else {
    // session-only: make sure no stale 30-day entry lingers.
    await chrome.storage.local.remove(PERSISTENT_KEY_CACHE);
  }
}

async function clearCachedKey(): Promise<void> {
  const session = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session;
  if (session) await session.remove(SESSION_KEY);
  await chrome.storage.local.remove(PERSISTENT_KEY_CACHE);
}

// ── Public API ────────────────────────────────────────────────────────

export const nsecStore = {
  /** Snapshot the current state. Decrypts opportunistically using a
   *  cached derived key when one exists. */
  async getState(): Promise<NsecState> {
    const a = await readAccount();
    if (!a) {
      return { empty: true, locked: false, protected: false, pubkey: null, nsecHex: null, signedInAt: null };
    }
    if (!a.encrypted) {
      return {
        empty: false, locked: false, protected: false,
        pubkey: a.pubkey, nsecHex: a.nsecHex, signedInAt: a.signedInAt,
      };
    }
    // Encrypted: try the cached key.
    const key = await readCachedKey();
    if (!key) {
      return {
        empty: false, locked: true, protected: true,
        pubkey: a.pubkey, nsecHex: null, signedInAt: a.signedInAt,
      };
    }
    try {
      const nsecHex = await decryptNsecWithKey(a.blob, key);
      return {
        empty: false, locked: false, protected: true,
        pubkey: a.pubkey, nsecHex, signedInAt: a.signedInAt,
      };
    } catch {
      // Cached key didn't decrypt (e.g. user rotated password elsewhere).
      // Treat as locked; UI will prompt for password.
      await clearCachedKey();
      return {
        empty: false, locked: true, protected: true,
        pubkey: a.pubkey, nsecHex: null, signedInAt: a.signedInAt,
      };
    }
  },

  /** Persist a new nsec from `nsec1…` bech32 or 64-char hex. Stores
   *  as a PlainAccount; user can opt-in to encryption later from
   *  Settings → Security. */
  async setPlain(input: string): Promise<NsecState> {
    const nsecHex = decodeNsecToHex(input);
    const pubkey = getPublicKey(hexToBytes(nsecHex));
    const record: PlainAccount = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      encrypted: false,
      nsecHex, pubkey,
      signedInAt: Math.floor(Date.now() / 1000),
    };
    await writeAccount(record);
    await clearCachedKey();
    return this.getState();
  },

  /** Encrypt the existing plaintext nsec with a password. The plaintext
   *  goes away; only ciphertext + the in-memory cached key remain. */
  async setPassword(password: string, mode: CacheMode = 'session'): Promise<NsecState> {
    if (!password) throw new Error('password required');
    const a = await readAccount();
    if (!a) throw new Error('no nsec stored — sign in first');
    if (a.encrypted) throw new Error('already password-protected — use changePassword instead');
    const blob = await encryptNsec(a.nsecHex, password);
    const record: EncryptedAccount = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      encrypted: true,
      pubkey: a.pubkey,
      signedInAt: a.signedInAt,
      blob,
    };
    await writeAccount(record);
    // Cache the derived key right away so the user isn't prompted
    // immediately after setting their password.
    const key = await deriveKeyFromExisting(password, blob);
    await writeCachedKey(key, mode);
    return this.getState();
  },

  /** Verify the password and cache the derived key per `mode`. Returns
   *  the new state — `locked: false` on success, throws on bad password. */
  async unlock(password: string, mode: CacheMode = 'session'): Promise<NsecState> {
    const a = await readAccount();
    if (!a || !a.encrypted) throw new Error('no encrypted account to unlock');
    // Validate by attempting decrypt — throws on bad password (AEAD
    // tag mismatch). Doesn't burn extra effort beyond the PBKDF2.
    const nsecHex = await decryptNsecWithPassword(a.blob, password);
    if (!/^[0-9a-f]{64}$/i.test(nsecHex)) throw new Error('decrypted output is not a valid nsec — corrupt blob');
    const key = await deriveKeyFromExisting(password, a.blob);
    await writeCachedKey(key, mode);
    return this.getState();
  },

  /** Drop the cached derived key — forces the next reveal/sign to
   *  prompt for the password again. */
  async lock(): Promise<NsecState> {
    await clearCachedKey();
    return this.getState();
  },

  /** Re-encrypt with a new password. Requires the old password (the
   *  cached key alone isn't enough — we don't expose it directly). */
  async changePassword(oldPassword: string, newPassword: string, mode: CacheMode = 'session'): Promise<NsecState> {
    if (!newPassword) throw new Error('new password required');
    const a = await readAccount();
    if (!a || !a.encrypted) throw new Error('no encrypted account');
    const nsecHex = await decryptNsecWithPassword(a.blob, oldPassword);
    const blob = await encryptNsec(nsecHex, newPassword);
    const record: EncryptedAccount = { ...a, blob };
    await writeAccount(record);
    const key = await deriveKeyFromExisting(newPassword, blob);
    await writeCachedKey(key, mode);
    return this.getState();
  },

  /** Decrypt + drop password protection (back to PlainAccount). */
  async removePassword(password: string): Promise<NsecState> {
    const a = await readAccount();
    if (!a || !a.encrypted) throw new Error('no encrypted account');
    const nsecHex = await decryptNsecWithPassword(a.blob, password);
    const record: PlainAccount = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      encrypted: false,
      nsecHex, pubkey: a.pubkey, signedInAt: a.signedInAt,
    };
    await writeAccount(record);
    await clearCachedKey();
    return this.getState();
  },

  /** Sign out — wipe the nsec entirely. UI calls this. */
  async clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
    await clearCachedKey();
  },

  /** Convenience for the "reveal my nsec" affordance. Returns the
   *  cleartext when unlocked / not protected. Throws when locked
   *  (caller should prompt for password and call unlock first). */
  async revealNsec(): Promise<string> {
    const state = await this.getState();
    if (state.empty) throw new Error('no nsec stored');
    if (state.locked) throw new Error('locked — enter your password first');
    return state.nsecHex!;
  },

  /** Bech32-encoded version of the cleartext nsec, for display + copy
   *  + download flows in Settings. */
  async revealNsecBech32(): Promise<string> {
    const hex = await this.revealNsec();
    return nip19.nsecEncode(hexToBytes(hex));
  },

  /** Decrypt the nsec with a password WITHOUT caching the derived key.
   *  Use this when the user wants to peek/copy/download their nsec but
   *  hasn't asked to unlock for the session. Avoids the trap where
   *  picking 'days30' on the reveal prompt would silently extend the
   *  unlock window for unrelated future operations. */
  async revealNsecBech32WithPassword(password: string): Promise<string> {
    const a = await readAccount();
    if (!a) throw new Error('no nsec stored');
    if (!a.encrypted) throw new Error('nsec is not password-protected');
    const hex = await decryptNsecWithPassword(a.blob, password);
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('decrypted output is not a valid nsec — corrupt blob');
    return nip19.nsecEncode(hexToBytes(hex));
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function decodeNsecToHex(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') throw new Error('Not a valid nsec.');
    return bytesToHex(decoded.data);
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  throw new Error('Expected nsec1… or 64-char hex secret.');
}
