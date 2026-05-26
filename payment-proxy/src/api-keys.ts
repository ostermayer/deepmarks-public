import { Redis } from 'ioredis';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';

/** Throw on any per-op error in a multi()/pipeline. Prevents silent
 *  partial writes from reading as success. */
async function execOrThrow(pipeline: { exec: () => Promise<unknown> }): Promise<void> {
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!results) throw new Error('redis pipeline failed (exec returned null)');
  for (const entry of results) {
    const err = entry?.[0];
    if (err) throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * API key store — paid-tier users get keys for programmatic bookmark access.
 *
 * Storage model:
 *   - Keyed by SHA-256 hash of the plaintext key, never the plaintext itself.
 *     (If Redis leaks the store the attacker gets hashes, not live keys.)
 *   - Reverse index per pubkey so the user can list / revoke their keys.
 *   - Plaintext is returned exactly once, at creation time. Callers must
 *     surface a "save this now, we can't show it again" UX.
 *
 * Wire format: `dmk_live_<43-char url-safe base64 of 32 random bytes>`.
 *   - `dmk_live_` prefix makes keys greppable and scanner-friendly
 *     (secret scanners can detect leaks in git / logs).
 *   - URL-safe base64 avoids shell-escaping pain.
 */

const KEY_PREFIX = 'dmk_live_';
const KEY_BODY_BYTES = 32;

const STORE_BY_HASH = 'dm:apikey:'; // hash → JSON record
const STORE_BY_PUBKEY = 'dm:apikeys:'; // pubkey → SET of hashes

export interface ApiKeyRecord {
  /** SHA-256 hex of the plaintext key. Doubles as the `id` exposed to the UI. */
  hash: string;
  pubkey: string;
  /** User-supplied name so they can tell keys apart. */
  label: string;
  createdAt: number;
  /** Unix seconds of last authenticated request. 0 = never used. */
  lastUsedAt: number;
}

export interface ApiKeyCreateResult {
  /** Plaintext key — show once, store nowhere. */
  plaintext: string;
  record: ApiKeyRecord;
}

// ── Pure helpers (tested without Redis) ────────────────────────────────

/** Generate a fresh plaintext key. 32 bytes of entropy, url-safe base64. */
export function generatePlaintextKey(): string {
  const body = toUrlSafeBase64(randomBytes(KEY_BODY_BYTES));
  return `${KEY_PREFIX}${body}`;
}

/** Hash a plaintext key. Constant-time-agnostic (SHA-256 has no secret input). */
export function hashKey(plaintext: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(plaintext)));
}

/** Well-formed? Shape check only — does NOT prove the key exists. */
export function looksLikeApiKey(s: string): boolean {
  if (!s.startsWith(KEY_PREFIX)) return false;
  const body = s.slice(KEY_PREFIX.length);
  // 32 bytes → 43 chars of url-safe base64 (no padding).
  return /^[A-Za-z0-9_-]{43}$/.test(body);
}

function toUrlSafeBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

// ── Redis-backed store ─────────────────────────────────────────────────

export class ApiKeyStore {
  constructor(private readonly redis: Redis) {}

  async create(pubkey: string, label: string): Promise<ApiKeyCreateResult> {
    const plaintext = generatePlaintextKey();
    const hash = hashKey(plaintext);
    const record: ApiKeyRecord = {
      hash,
      pubkey,
      label: label.trim().slice(0, 80) || 'unnamed',
      createdAt: Math.floor(Date.now() / 1000),
      lastUsedAt: 0
    };
    // Pipeline must use execOrThrow — a silent SADD failure after a
    // successful SET would leave a usable key the owner couldn't see
    // or revoke.
    await execOrThrow(
      this.redis
        .multi()
        .set(STORE_BY_HASH + hash, JSON.stringify(record))
        .sadd(STORE_BY_PUBKEY + pubkey, hash),
    );
    return { plaintext, record };
  }

  /** Look up by plaintext key. Returns null on unknown / wrong-shape. */
  async lookup(plaintext: string): Promise<ApiKeyRecord | null> {
    if (!looksLikeApiKey(plaintext)) return null;
    const hash = hashKey(plaintext);
    const raw = await this.redis.get(STORE_BY_HASH + hash);
    if (!raw) return null;
    return JSON.parse(raw) as ApiKeyRecord;
  }

  /** Record a successful auth; updates lastUsedAt at 1-minute granularity. */
  async touch(hash: string): Promise<void> {
    const raw = await this.redis.get(STORE_BY_HASH + hash);
    if (!raw) return;
    const rec = JSON.parse(raw) as ApiKeyRecord;
    const now = Math.floor(Date.now() / 1000);
    if (now - rec.lastUsedAt < 60) return; // coalesce writes
    rec.lastUsedAt = now;
    await this.redis.set(STORE_BY_HASH + hash, JSON.stringify(rec));
  }

  /** List all keys owned by a pubkey. Plaintext is NEVER returned here. */
  async listByPubkey(pubkey: string): Promise<ApiKeyRecord[]> {
    const hashes = await this.redis.smembers(STORE_BY_PUBKEY + pubkey);
    if (hashes.length === 0) return [];
    const raws = await this.redis.mget(...hashes.map((h) => STORE_BY_HASH + h));
    const out: ApiKeyRecord[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      try { out.push(JSON.parse(raw) as ApiKeyRecord); }
      catch { /* skip corrupt blob — never crash the request handler */ }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  /** Revoke every key owned by a pubkey. Idempotent — safe on empty sets. */
  async revokeAll(pubkey: string): Promise<{ revoked: number }> {
    const hashes = await this.redis.smembers(STORE_BY_PUBKEY + pubkey);
    const pipeline = this.redis.multi();
    for (const h of hashes) pipeline.del(STORE_BY_HASH + h);
    pipeline.del(STORE_BY_PUBKEY + pubkey);
    await execOrThrow(pipeline);
    return { revoked: hashes.length };
  }

  /** Revoke by hash. Safe to call on already-revoked keys (idempotent). */
  async revoke(pubkey: string, hash: string): Promise<boolean> {
    // Confirm the hash belongs to this pubkey before deleting — prevents
    // one user from revoking another's key by guessing hashes.
    const raw = await this.redis.get(STORE_BY_HASH + hash);
    if (!raw) return false;
    let rec: ApiKeyRecord;
    try { rec = JSON.parse(raw) as ApiKeyRecord; }
    catch { return false; }
    if (rec.pubkey !== pubkey) return false;
    await execOrThrow(
      this.redis
        .multi()
        .del(STORE_BY_HASH + hash)
        .srem(STORE_BY_PUBKEY + pubkey, hash),
    );
    return true;
  }
}
