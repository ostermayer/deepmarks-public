import { Redis } from 'ioredis';

const BLOCKED_HASHES = 'dm:blocked-hashes';
const BLOCKED_URLS = 'dm:blocked-urls';
const DELISTED_EVENTS = 'dm:delisted-events';
const SUSPENSION_PREFIX = 'dm:suspended:'; // keyed by pubkey

/**
 * Blocklist store for moderation enforcement.
 *
 * Three sets + a suspension map. All lookups are O(1) Redis SISMEMBER
 * calls — cheap enough to query on every relay write, every Blossom
 * read/write, every archive purchase.
 *
 * - BLOCKED_HASHES: SHA-256 hex strings of blobs we've taken down.
 *   blossom-server rejects uploads matching these and returns 410 for reads.
 * - BLOCKED_URLS: canonical URLs of pages we won't index. Relay write-policy
 *   rejects new kind:39701 events with these URLs in the `d` tag.
 * - DELISTED_EVENTS: Nostr event IDs we've delisted. Relay write-policy
 *   rejects republishes; subscription filter drops these from outgoing events.
 * - Suspensions: per-pubkey, optional expiry for time-limited bans.
 */
export class BlocklistStore {
  constructor(private readonly redis: Redis) {}

  // ─── Hash blocklist ─────────────────────────────────────────────────

  async blockHash(hash: string, reason: string, adminPubkey: string): Promise<void> {
    await this.redis
      .multi()
      .sadd(BLOCKED_HASHES, hash.toLowerCase())
      .set(
        `${BLOCKED_HASHES}:reason:${hash}`,
        JSON.stringify({ reason, adminPubkey, at: Math.floor(Date.now() / 1000) }),
      )
      .exec();
  }

  async unblockHash(hash: string): Promise<void> {
    await this.redis
      .multi()
      .srem(BLOCKED_HASHES, hash.toLowerCase())
      .del(`${BLOCKED_HASHES}:reason:${hash}`)
      .exec();
  }

  async isHashBlocked(hash: string): Promise<boolean> {
    const r = await this.redis.sismember(BLOCKED_HASHES, hash.toLowerCase());
    return r === 1;
  }

  // ─── URL blocklist ──────────────────────────────────────────────────

  async blockUrl(url: string, reason: string, adminPubkey: string): Promise<void> {
    const normalized = normalizeUrl(url);
    await this.redis
      .multi()
      .sadd(BLOCKED_URLS, normalized)
      .set(
        `${BLOCKED_URLS}:reason:${normalized}`,
        JSON.stringify({ reason, adminPubkey, at: Math.floor(Date.now() / 1000) }),
      )
      .exec();
  }

  async unblockUrl(url: string): Promise<void> {
    const normalized = normalizeUrl(url);
    await this.redis
      .multi()
      .srem(BLOCKED_URLS, normalized)
      .del(`${BLOCKED_URLS}:reason:${normalized}`)
      .exec();
  }

  async isUrlBlocked(url: string): Promise<boolean> {
    const r = await this.redis.sismember(BLOCKED_URLS, normalizeUrl(url));
    return r === 1;
  }

  // ─── Event delisting ────────────────────────────────────────────────

  async delistEvent(eventId: string, reason: string, adminPubkey: string): Promise<void> {
    await this.redis
      .multi()
      .sadd(DELISTED_EVENTS, eventId.toLowerCase())
      .set(
        `${DELISTED_EVENTS}:reason:${eventId}`,
        JSON.stringify({ reason, adminPubkey, at: Math.floor(Date.now() / 1000) }),
      )
      .exec();
  }

  async relistEvent(eventId: string): Promise<void> {
    await this.redis
      .multi()
      .srem(DELISTED_EVENTS, eventId.toLowerCase())
      .del(`${DELISTED_EVENTS}:reason:${eventId}`)
      .exec();
  }

  async isEventDelisted(eventId: string): Promise<boolean> {
    const r = await this.redis.sismember(DELISTED_EVENTS, eventId.toLowerCase());
    return r === 1;
  }

  // ─── Pubkey suspension ──────────────────────────────────────────────

  async suspendPubkey(
    pubkey: string,
    reason: string,
    adminPubkey: string,
    expiresAt?: number,
  ): Promise<void> {
    const record = {
      reason,
      adminPubkey,
      at: Math.floor(Date.now() / 1000),
      expiresAt,
    };
    if (expiresAt) {
      const ttl = expiresAt - Math.floor(Date.now() / 1000);
      await this.redis.set(SUSPENSION_PREFIX + pubkey, JSON.stringify(record), 'EX', ttl);
    } else {
      await this.redis.set(SUSPENSION_PREFIX + pubkey, JSON.stringify(record));
    }
  }

  async unsuspendPubkey(pubkey: string): Promise<void> {
    await this.redis.del(SUSPENSION_PREFIX + pubkey);
  }

  async isPubkeySuspended(pubkey: string): Promise<boolean> {
    const r = await this.redis.exists(SUSPENSION_PREFIX + pubkey);
    return r === 1;
  }

  async getSuspensionReason(pubkey: string): Promise<string | null> {
    const raw = await this.redis.get(SUSPENSION_PREFIX + pubkey);
    if (!raw) return null;
    return JSON.parse(raw).reason;
  }
}

/**
 * Normalize a URL for blocklist comparison. Strip trailing slashes,
 * lowercase scheme+host, drop fragment, strip tracking params.
 *
 * Exported so the unit test can pin the rules without spinning up Redis.
 */
export function normalizeUrl(input: string): string {
  try {
    const u = new URL(input.trim());
    u.hash = '';
    // Strip well-known tracking params
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref', 'mc_cid', 'mc_eid',
    ];
    for (const p of trackingParams) u.searchParams.delete(p);
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return input.trim().toLowerCase();
  }
}
