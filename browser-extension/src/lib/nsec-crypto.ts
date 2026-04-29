// Password-based nsec encryption — PBKDF2-SHA256 + AES-GCM-256.
//
// Threat model: protect the nsec at rest from a casual disk-grab
// attacker (browser profile copied off disk, malware that reads
// localStorage but doesn't dump session memory). A focused attacker
// who runs malicious code inside the extension origin has the same
// access we do; encryption can't help there. Same posture as Alby.
//
// Parameters chosen for browser-runtime sanity:
//   PBKDF2 iterations: 600_000 (OWASP 2023 recommendation for SHA-256)
//   Salt: 16 random bytes
//   AES-GCM key: 256-bit
//   IV: 12 random bytes per encryption
//
// Format-of-encrypted-record lives in nsec-store.ts; this module is
// pure crypto primitives.

const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BITS = 256;

export interface EncryptedBlob {
  ciphertextB64: string;
  ivB64: string;
  saltB64: string;
  iterations: number;
  kdf: 'pbkdf2-sha256';
}

/** Derive a 256-bit AES-GCM key from the user's password + a random salt. */
async function deriveKey(password: string, salt: Uint8Array, iterations = ITERATIONS): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_BITS },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
}

/** Derive the same key from a password + an already-stored salt — used
 *  on unlock when we know the salt the original encryption used. */
export async function deriveKeyFromExisting(
  password: string,
  blob: { saltB64: string; iterations: number },
): Promise<CryptoKey> {
  return deriveKey(password, b64ToBytes(blob.saltB64), blob.iterations);
}

/** Encrypt the nsec (hex string) under a fresh PBKDF2/AES-GCM scheme. */
export async function encryptNsec(nsecHex: string, password: string): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(nsecHex) as BufferSource,
  );
  return {
    ciphertextB64: bytesToB64(new Uint8Array(ctBuf)),
    ivB64: bytesToB64(iv),
    saltB64: bytesToB64(salt),
    iterations: ITERATIONS,
    kdf: 'pbkdf2-sha256',
  };
}

/** Decrypt with a CryptoKey we already derived (e.g. from a cached
 *  unlock). Throws on AEAD-tag mismatch — caller should treat that as
 *  "wrong password / corrupt blob". */
export async function decryptNsecWithKey(blob: EncryptedBlob, key: CryptoKey): Promise<string> {
  const ptBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(blob.ivB64) as BufferSource },
    key,
    b64ToBytes(blob.ciphertextB64) as BufferSource,
  );
  return new TextDecoder().decode(ptBuf);
}

/** Decrypt with a password — runs PBKDF2 then GCM. Slow on purpose
 *  (PBKDF2 is the cost). Use decryptNsecWithKey() when you've already
 *  cached a derived key. */
export async function decryptNsecWithPassword(blob: EncryptedBlob, password: string): Promise<string> {
  const key = await deriveKeyFromExisting(password, blob);
  return decryptNsecWithKey(blob, key);
}

/** Export a CryptoKey to raw bytes so we can stash it in
 *  chrome.storage.session (which only takes JSON-serializable values).
 *  The key is NOT a secret in the same sense the password is — it's
 *  derived material that lasts as long as the cache window. */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToB64(new Uint8Array(raw));
}

export async function importKey(rawB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    b64ToBytes(rawB64) as BufferSource,
    { name: 'AES-GCM', length: KEY_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
}

// ── Base64 helpers ───────────────────────────────────────────────────

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
