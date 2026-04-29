// Deepmarks short usernames — lifetime-tier perk.
//
// Lifetime members can claim a short lowercase handle to get a tidy
// profile URL at deepmarks.org/u/<name> in addition to the always-working
// /u/<npub1…> form. A handle is just a convenience — the user's npub is
// the real identity; the handle is a rented mapping in Redis.
//
// Rules:
//  • 3–30 chars, [a-z0-9-] only, no leading/trailing dash
//  • Lifetime-only (server enforces via LifetimeStore)
//  • Reserved names (routes + generic/system words) are unclaimable
//  • One handle per pubkey; claiming a new one drops the old one into cooldown
//  • After release: a 30-day cooldown holds the name before anyone else
//    (other than the releasing pubkey) can claim it. Original owner can
//    reclaim instantly during the cooldown window.
//
// Storage (Redis):
//   dm:username:byname       hash   name → pubkey           (active claims)
//   dm:username:bypubkey     hash   pubkey → name           (reverse)
//   dm:username:cooldown:<name>  string = pubkey   TTL 30d  (pending reclaim window)

import { Redis } from 'ioredis';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_COOLDOWN_SECONDS = 30 * 24 * 60 * 60;

const KEY_BYNAME = 'dm:username:byname';
const KEY_BYPUBKEY = 'dm:username:bypubkey';
const KEY_COOLDOWN = (name: string) => `dm:username:cooldown:${name}`;
/** Per-name mutex. SETNX-backed, 5s TTL so a crashed process can't hold a
 *  handle hostage forever. Two concurrent claim()s for the same name
 *  race on this key; whoever loses gets { error: 'taken' } back. */
const KEY_CLAIM_LOCK = (name: string) => `dm:username:lock:${name}`;
const CLAIM_LOCK_TTL_SECONDS = 5;

/**
 * Run a pipeline and throw if the Redis server reported an error on any
 * op. The raw ioredis `exec` returns `[[err, result], …]`; a silent
 * pipeline is the bug we don't want. Caller should treat a throw as a
 * hard 5xx, not a soft state-change.
 */
async function execOrThrow(pipeline: { exec: () => Promise<unknown> }): Promise<void> {
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!results) throw new Error('redis pipeline failed (exec returned null)');
  for (const entry of results) {
    const err = entry?.[0];
    if (err) throw err instanceof Error ? err : new Error(String(err));
  }
}

// Routes, generic/system words, and confusable admin/ops terms. Lowercase;
// exact match. Kept small + static — a database-backed list would be
// over-engineering for a handful of forbidden strings.
export const RESERVED_USERNAMES = new Set<string>([
  'about', 'admin', 'administrator', 'api', 'app', 'archive', 'archives',
  'auth', 'blog', 'bookmarks', 'boot', 'changelog', 'checkout', 'claim',
  'connect', 'contact', 'dashboard', 'deepmarks', 'developer', 'developers',
  'docs', 'download', 'edit', 'faq', 'favicon', 'feedback', 'help', 'home',
  'index', 'jobs', 'license', 'log', 'login', 'logout', 'mail', 'me',
  'nip05', 'nostr', 'null', 'oauth', 'official', 'operator', 'pages',
  'password', 'pay', 'payment', 'popular', 'post', 'posts', 'pricing',
  'privacy', 'profile', 'public', 'recent', 'register', 'relay', 'relays',
  'root', 'rss', 'search', 'security', 'settings', 'setup', 'signin',
  'signout', 'signup', 'site', 'sitemap', 'source', 'status', 'staff',
  'static', 'support', 'system', 'tag', 'tags', 'team', 'terms', 'test',
  'u', 'undefined', 'upgrade', 'user', 'users', 'v1', 'v2', 'verify',
  'webhook', 'well-known', 'wellknown', 'www', 'zap', 'zaps',
]);

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;

export function isWellFormedUsername(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length < USERNAME_MIN_LENGTH || name.length > USERNAME_MAX_LENGTH) return false;
  if (!USERNAME_RE.test(name)) return false;
  if (name.includes('--')) return false; // no double-dash runs
  return true;
}

export function isReservedUsername(name: string): boolean {
  return RESERVED_USERNAMES.has(name);
}

export type ClaimResult =
  | { ok: true; name: string }
  | { ok: false; error: 'invalid' | 'reserved' | 'taken' | 'cooldown' | 'not-lifetime' };

export class UsernameStore {
  constructor(private readonly redis: Redis) {}

  /** Lowercase and trim, no other transform — caller decides what to pass. */
  private canonical(name: string): string {
    return (name ?? '').trim().toLowerCase();
  }

  /**
   * Try to claim `name` for `pubkey`. `isLifetime` is injected so this
   * module doesn't import LifetimeStore and tests stay pure.
   *
   *   - rejects format/reserved first (cheap checks)
   *   - rejects if the pubkey is not a lifetime member
   *   - accepts instantly if the name is free
   *   - accepts during a cooldown if the cooling pubkey is the same caller
   *     (lets an owner reclaim their own handle)
   *   - rejects with 'cooldown' if a *different* pubkey holds the cooldown
   *   - on success, releases the caller's previous handle (if any) into
   *     its own 30-day cooldown.
   */
  async claim(pubkey: string, rawName: string, isLifetime: boolean): Promise<ClaimResult> {
    if (!isLifetime) return { ok: false, error: 'not-lifetime' };
    const name = this.canonical(rawName);
    if (!isWellFormedUsername(name)) return { ok: false, error: 'invalid' };
    if (isReservedUsername(name)) return { ok: false, error: 'reserved' };

    // Acquire a per-name lock so two concurrent claim()s for the same
    // name can't both pass the `existingOwner` check below and each
    // write different sides of the byname/bypubkey mapping (TOCTOU).
    // The loser gets 'taken' — one retry after a small backoff smooths
    // the common "double-click claim" case.
    const lockKey = KEY_CLAIM_LOCK(name);
    const lockedClient = this.redis as unknown as {
      set(k: string, v: string, mode: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
    };
    let lock = await lockedClient.set(lockKey, pubkey, 'EX', CLAIM_LOCK_TTL_SECONDS, 'NX');
    if (!lock) {
      await new Promise((r) => setTimeout(r, 50));
      lock = await lockedClient.set(lockKey, pubkey, 'EX', CLAIM_LOCK_TTL_SECONDS, 'NX');
    }
    if (!lock) return { ok: false, error: 'taken' };

    try {
      // No-op if the caller already owns this exact handle.
      const existingOwner = await this.redis.hget(KEY_BYNAME, name);
      if (existingOwner === pubkey) return { ok: true, name };
      if (existingOwner) return { ok: false, error: 'taken' };

      // Cooldown check: a different pubkey can't claim a name still cooling
      // for someone else.
      const cooldownOwner = await this.redis.get(KEY_COOLDOWN(name));
      if (cooldownOwner && cooldownOwner !== pubkey) {
        return { ok: false, error: 'cooldown' };
      }

      // Release caller's current handle (if any) into cooldown.
      const priorName = await this.redis.hget(KEY_BYPUBKEY, pubkey);
      const pipeline = this.redis.multi();
      if (priorName && priorName !== name) {
        pipeline.hdel(KEY_BYNAME, priorName);
        pipeline.set(KEY_COOLDOWN(priorName), pubkey, 'EX', USERNAME_COOLDOWN_SECONDS);
      }
      pipeline.hset(KEY_BYNAME, name, pubkey);
      pipeline.hset(KEY_BYPUBKEY, pubkey, name);
      // Clear any pending cooldown this pubkey had on this name — they're
      // active again.
      pipeline.del(KEY_COOLDOWN(name));
      await execOrThrow(pipeline);

      return { ok: true, name };
    } finally {
      // Best-effort lock release. If this fails the TTL (5s) cleans up.
      await this.redis.del(lockKey).catch(() => { /* ignore */ });
    }
  }

  /** Release the pubkey's current handle (if any) into its 30-day cooldown. */
  async release(pubkey: string): Promise<{ released: string | null }> {
    const name = await this.redis.hget(KEY_BYPUBKEY, pubkey);
    if (!name) return { released: null };
    const pipeline = this.redis.multi();
    pipeline.hdel(KEY_BYNAME, name);
    pipeline.hdel(KEY_BYPUBKEY, pubkey);
    pipeline.set(KEY_COOLDOWN(name), pubkey, 'EX', USERNAME_COOLDOWN_SECONDS);
    await execOrThrow(pipeline);
    return { released: name };
  }

  /** Resolve a handle to a pubkey, or null if unclaimed. */
  async lookup(rawName: string): Promise<string | null> {
    const name = this.canonical(rawName);
    if (!isWellFormedUsername(name)) return null;
    return (await this.redis.hget(KEY_BYNAME, name)) ?? null;
  }

  /** Reverse — what handle (if any) does this pubkey hold? */
  async usernameOf(pubkey: string): Promise<string | null> {
    return (await this.redis.hget(KEY_BYPUBKEY, pubkey)) ?? null;
  }

  /**
   * Availability check for the UI. Returns a reason the caller can show
   * without committing a claim. `asPubkey` is optional — when present,
   * a name the caller already owns counts as available (no-op claim
   * would succeed).
   */
  async check(
    rawName: string,
    asPubkey?: string,
  ): Promise<{ available: true } | { available: false; reason: 'invalid' | 'reserved' | 'taken' | 'cooldown' }> {
    const name = this.canonical(rawName);
    if (!isWellFormedUsername(name)) return { available: false, reason: 'invalid' };
    if (isReservedUsername(name)) return { available: false, reason: 'reserved' };
    const owner = await this.redis.hget(KEY_BYNAME, name);
    if (owner) {
      if (asPubkey && owner === asPubkey) return { available: true };
      return { available: false, reason: 'taken' };
    }
    const cooldownOwner = await this.redis.get(KEY_COOLDOWN(name));
    if (cooldownOwner && (!asPubkey || cooldownOwner !== asPubkey)) {
      return { available: false, reason: 'cooldown' };
    }
    return { available: true };
  }
}
