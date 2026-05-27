import { Redis } from 'ioredis';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Run a multi()/pipeline and throw on any error returned from the Redis
 * server. `ioredis` resolves exec() even when individual ops fail; without
 * this, a hard write error reads as a successful state change.
 */
async function execOrThrow(pipeline: { exec: () => Promise<unknown> }): Promise<void> {
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!results) throw new Error('redis pipeline failed (exec returned null)');
  for (const entry of results) {
    const err = entry?.[0];
    if (err) throw err instanceof Error ? err : new Error(String(err));
  }
}

const ACCOUNT_PREFIX = 'dm:acct:';
const PUBKEY_PREFIX = 'dm:pk:';
const PRIVATE_MARK_PREFIX = 'dm:private:';
const PRIVATE_INDEX_PREFIX = 'dm:private-idx:';

export interface Account {
  emailHash: string;
  pubkey: string;
  encryptedViewKey: string;
  salt: string;
  kdfParams: {
    algorithm: 'argon2id';
    memory: number;
    iterations: number;
    parallelism: number;
  };
  /**
   * Monotonic counter that bumps on security-sensitive changes
   * (key rotation, passphrase change). JWTs carry the version they
   * were issued at; when claims.session_version < account.session_version
   * the token is rejected. This invalidates all existing sessions on
   * rotation so a stolen JWT can't survive a key rotation.
   */
  sessionVersion: number;
  createdAt: number;
  lastSigninAt?: number;
  /**
   * Custom Blossom mirror list (Flow L). If unset, the archive worker falls
   * back to the default 4-operator set. Stored as URLs (no trailing slash).
   */
  mirrors?: string[];
  /**
   * Unix seconds when the user paid for the lifetime tier (21,000 sats).
   * Only lifetime members get programmatic API access — see api-keys.ts.
   * Per-archive buyers are not lifetime members; they can still save / zap
   * / archive manually through the app.
   */
  lifetimePaidAt?: number;
}

export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return bytesToHex(sha256(new TextEncoder().encode(normalized)));
}

/** Defensive JSON parse — a single corrupt account record (Redis hiccup,
 *  schema-drift bug) would otherwise crash every signin / lifetime check
 *  / API-key call that touched it. Treat as missing instead. */
function parseAccountOrNull(raw: string | null): Account | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as Account; }
  catch { return null; }
}

export class AccountStore {
  constructor(private readonly redis: Redis) {}

  async getByEmail(email: string): Promise<Account | null> {
    const hash = hashEmail(email);
    const raw = await this.redis.get(ACCOUNT_PREFIX + hash);
    return parseAccountOrNull(raw);
  }

  async getByPubkey(pubkey: string): Promise<Account | null> {
    const hash = await this.redis.get(PUBKEY_PREFIX + pubkey);
    if (!hash) return null;
    const raw = await this.redis.get(ACCOUNT_PREFIX + hash);
    return parseAccountOrNull(raw);
  }

  /**
   * Lifetime-tier gate. Anyone can use the app / save / zap without an
   * account; the lifetime marker is only set when a 21,000-sat payment
   * settles. API access is gated on this and nothing else.
   */
  async isLifetimeMember(pubkey: string): Promise<boolean> {
    const acct = await this.getByPubkey(pubkey);
    return !!acct?.lifetimePaidAt;
  }

  /** Stamp the lifetime-tier marker (idempotent). */
  async markLifetimePaid(pubkey: string, at = Math.floor(Date.now() / 1000)): Promise<void> {
    const hash = await this.redis.get(PUBKEY_PREFIX + pubkey);
    if (!hash) throw new Error('account not found for pubkey');
    const raw = await this.redis.get(ACCOUNT_PREFIX + hash);
    const account = parseAccountOrNull(raw);
    if (!account) throw new Error('account record missing or corrupt');
    if (account.lifetimePaidAt) return; // idempotent
    account.lifetimePaidAt = at;
    await this.redis.set(ACCOUNT_PREFIX + hash, JSON.stringify(account));
  }

  async getByEmailHash(emailHash: string): Promise<Account | null> {
    const raw = await this.redis.get(ACCOUNT_PREFIX + emailHash);
    return parseAccountOrNull(raw);
  }

  async create(account: Account): Promise<void> {
    await execOrThrow(
      this.redis
        .multi()
        .set(ACCOUNT_PREFIX + account.emailHash, JSON.stringify(account))
        .set(PUBKEY_PREFIX + account.pubkey, account.emailHash),
    );
  }

  async rotatePubkey(emailHash: string, newPubkey: string): Promise<Account> {
    const raw = await this.redis.get(ACCOUNT_PREFIX + emailHash);
    const account = parseAccountOrNull(raw);
    if (!account) throw new Error('account not found');
    const oldPubkey = account.pubkey;
    account.pubkey = newPubkey;
    account.sessionVersion += 1;

    await execOrThrow(
      this.redis
        .multi()
        .set(ACCOUNT_PREFIX + emailHash, JSON.stringify(account))
        .del(PUBKEY_PREFIX + oldPubkey)
        .set(PUBKEY_PREFIX + newPubkey, emailHash),
    );
    // Private marks are keyed by emailHash, so rotation leaves them
    // in place — no migration needed, no orphan ciphertext.
    return account;
  }

  async touchSignin(emailHash: string): Promise<void> {
    const raw = await this.redis.get(ACCOUNT_PREFIX + emailHash);
    const account = parseAccountOrNull(raw);
    if (!account) return;
    account.lastSigninAt = Math.floor(Date.now() / 1000);
    await this.redis.set(ACCOUNT_PREFIX + emailHash, JSON.stringify(account));
  }

  /**
   * Wipe the account record tied to `pubkey`. Returns the emailHash that
   * was attached (if any) so the caller can also clear PrivateMarkStore
   * entries, which are keyed by emailHash rather than pubkey.
   *
   * Deliberately NOT linked to LifetimeStore — lifetime status survives
   * account deletion. A user who deletes + later signs back in with the
   * same nsec still has their paid status.
   */
  async deleteByPubkey(pubkey: string): Promise<{ deletedEmailHash: string | null }> {
    const hash = await this.redis.get(PUBKEY_PREFIX + pubkey);
    const pipeline = this.redis.multi();
    pipeline.del(PUBKEY_PREFIX + pubkey);
    if (hash) pipeline.del(ACCOUNT_PREFIX + hash);
    await execOrThrow(pipeline);
    return { deletedEmailHash: hash };
  }
}

// ─── Private mark storage (cache of NIP-51 state) ─────────────────────
//
// These blobs are a CACHE of the user's NIP-51 private-bookmark sets,
// stored encrypted-to-view-key so email-only sessions can decrypt them
// client-side. The Nostr relay copy is the source of truth. Clients
// reconcile this cache on signer connect: we hand back an index
// (id, contentHash, createdAt) and the client uploads any NIP-51 events
// we're missing, updates stale ones, and deletes entries that no longer
// exist on the network.
//
// Keyed by emailHash (not pubkey) so nsec rotation doesn't orphan data.

export interface PrivateMarkCiphertext {
  /** Stable ID — the d-tag from the NIP-51 set entry (or the event ID). */
  id: string;
  ciphertext: string;   // base64 AES-GCM output
  nonce: string;        // base64
  /** created_at from the source NIP-51 event. Used for LWW on conflict. */
  createdAt: number;
  /** SHA-256 of ciphertext, hex. Clients use this to detect drift cheaply. */
  contentHash: string;
}

export class PrivateMarkStore {
  constructor(private readonly redis: Redis) {}

  async put(emailHash: string, mark: PrivateMarkCiphertext): Promise<'created' | 'updated' | 'stale'> {
    const key = `${PRIVATE_MARK_PREFIX}${emailHash}:${mark.id}`;
    const existing = await this.redis.get(key);
    if (existing) {
      const prev = JSON.parse(existing) as PrivateMarkCiphertext;
      // Last-writer-wins by NIP-51 created_at. If the incoming mark is
      // older than what we already have, reject — client probably has
      // a stale relay view.
      if (prev.createdAt > mark.createdAt) return 'stale';
      if (prev.contentHash === mark.contentHash) return 'updated';
    }
    await this.redis
      .multi()
      .set(key, JSON.stringify(mark))
      .sadd(PRIVATE_INDEX_PREFIX + emailHash, mark.id)
      .exec();
    return existing ? 'updated' : 'created';
  }

  async get(
    emailHash: string,
    markId: string,
  ): Promise<PrivateMarkCiphertext | null> {
    const raw = await this.redis.get(
      `${PRIVATE_MARK_PREFIX}${emailHash}:${markId}`,
    );
    return raw ? (JSON.parse(raw) as PrivateMarkCiphertext) : null;
  }

  async listAll(emailHash: string): Promise<PrivateMarkCiphertext[]> {
    const ids = await this.redis.smembers(PRIVATE_INDEX_PREFIX + emailHash);
    if (ids.length === 0) return [];
    const keys = ids.map((id) => `${PRIVATE_MARK_PREFIX}${emailHash}:${id}`);
    const raws = await this.redis.mget(...keys);
    return raws
      .filter((r): r is string => !!r)
      .map((r) => JSON.parse(r) as PrivateMarkCiphertext);
  }

  async listIndex(
    emailHash: string,
  ): Promise<Array<{ id: string; contentHash: string; createdAt: number }>> {
    const all = await this.listAll(emailHash);
    return all.map((m) => ({
      id: m.id,
      contentHash: m.contentHash,
      createdAt: m.createdAt,
    }));
  }

  async delete(emailHash: string, markId: string): Promise<void> {
    await this.redis
      .multi()
      .del(`${PRIVATE_MARK_PREFIX}${emailHash}:${markId}`)
      .srem(PRIVATE_INDEX_PREFIX + emailHash, markId)
      .exec();
  }

  /**
   * Drop every private-mark blob tied to an emailHash. Used on account
   * deletion; there is no undo — the canonical copy of the set lives on
   * Nostr relays, we only cache the ciphertexts here.
   */
  async deleteAllByEmailHash(emailHash: string): Promise<{ removed: number }> {
    const ids = await this.redis.smembers(PRIVATE_INDEX_PREFIX + emailHash);
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.del(`${PRIVATE_MARK_PREFIX}${emailHash}:${id}`);
    }
    pipeline.del(PRIVATE_INDEX_PREFIX + emailHash);
    await execOrThrow(pipeline);
    return { removed: ids.length };
  }

  /**
   * Bulk reconcile. Client sends its current view of NIP-51 state
   * (id + contentHash for each extant private mark). Server returns
   * which IDs to upload/update and which existing IDs to delete.
   */
  async reconcilePlan(
    emailHash: string,
    clientState: Array<{ id: string; contentHash: string; createdAt: number }>,
  ): Promise<{
    toUpload: string[];   // IDs the client has that we don't (or that differ)
    toDelete: string[];   // IDs we have that the client says no longer exist
  }> {
    const ours = await this.listIndex(emailHash);
    const oursById = new Map(ours.map((m) => [m.id, m]));
    const clientIds = new Set(clientState.map((m) => m.id));

    const toUpload: string[] = [];
    for (const c of clientState) {
      const match = oursById.get(c.id);
      if (!match) {
        toUpload.push(c.id);
      } else if (match.contentHash !== c.contentHash && c.createdAt > match.createdAt) {
        toUpload.push(c.id);
      }
    }

    const toDelete: string[] = [];
    for (const o of ours) {
      if (!clientIds.has(o.id)) toDelete.push(o.id);
    }

    return { toUpload, toDelete };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
