import type { Redis } from 'ioredis';
import type { Event as NostrEvent } from 'nostr-tools';

import { enqueueOnboardingScan } from './registry.js';

const FOLLOWS_BY_USER_PREFIX = 'dm:follows:by-user:';
const CONTACTS_WATCHED_SET = 'dm:contacts:watched';
const CONTACTS_LAST_INGEST_PREFIX = 'dm:contacts:last-ingest:v2:';
const RELAY_ALLOWED_SYNC_LAST_PREFIX = 'dm:contacts:sync:last:';
const ACTIVE_WARMUP_LOCK_PREFIX = 'dm:friends:warmup:active:';
const ONBOARDING_REFRESH_LOCK_PREFIX = 'dm:friends:warmup:onboarding:';
const ACTIVE_WARMUP_LOCK_TTL_S = 15 * 60;
const ONBOARDING_REFRESH_LOCK_TTL_S = 6 * 60 * 60;
const MAX_FOLLOWS_TO_PRIORITIZE = 500;

/**
 * Prioritize friend-feed cache work for a user who is actively saving
 * bookmarks. This is intentionally best-effort: the save path must remain
 * fast, but active curators should cause their own follows and friends'
 * bookmarks to be warm before they open /app/friends.
 */
export async function scheduleActiveUserFriendWarmup(redis: Redis, pubkey: string): Promise<void> {
  const owner = normalizePubkey(pubkey);
  if (!owner) return;

  const claimed = await setNx(redis, ACTIVE_WARMUP_LOCK_PREFIX + owner, ACTIVE_WARMUP_LOCK_TTL_S);
  if (!claimed) return;

  await safeDel(redis, RELAY_ALLOWED_SYNC_LAST_PREFIX + owner);

  const follows = await redis.smembers(FOLLOWS_BY_USER_PREFIX + owner).catch(() => [] as string[]);
  const watched = uniquePubkeys(follows).filter((pk) => pk !== owner).slice(0, MAX_FOLLOWS_TO_PRIORITIZE);
  if (watched.length > 0) {
    await prioritizeWatchedPubkeys(redis, watched);
    return;
  }

  const scanClaimed = await setNx(redis, ONBOARDING_REFRESH_LOCK_PREFIX + owner, ONBOARDING_REFRESH_LOCK_TTL_S);
  if (scanClaimed) {
    void enqueueOnboardingScan(redis, owner).catch(() => undefined);
  }
}

/**
 * Inline companion to follows-ingester's relay subscription. When a user
 * publishes a kind:3 contact list or kind:30000 friends set through
 * /publish, this seeds Redis immediately instead of waiting for the queued
 * relay publish and subscription round-trip.
 */
export async function warmFollowSource(redis: Redis, event: Pick<NostrEvent, 'kind' | 'pubkey' | 'tags'>): Promise<void> {
  if (event.kind !== 3 && event.kind !== 30000) return;
  const follower = normalizePubkey(event.pubkey);
  if (!follower) return;

  const followed = uniquePubkeys(
    event.tags
      .filter((tag) => tag[0] === 'p')
      .map((tag) => tag[1]),
  ).filter((pk) => pk !== follower);
  if (followed.length === 0) return;

  const pipeline = redis.multi();
  if (event.kind === 3) {
    const userKey = FOLLOWS_BY_USER_PREFIX + follower;
    pipeline.del(userKey);
    pipeline.sadd(userKey, ...followed);
    pipeline.expire(userKey, 30 * 24 * 60 * 60);
  }
  pipeline.sadd(CONTACTS_WATCHED_SET, ...followed);
  for (const pubkey of followed.slice(0, MAX_FOLLOWS_TO_PRIORITIZE)) {
    pipeline.del(CONTACTS_LAST_INGEST_PREFIX + pubkey);
  }
  await pipeline.exec().catch(() => undefined);
}

async function prioritizeWatchedPubkeys(redis: Redis, pubkeys: string[]): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.sadd(CONTACTS_WATCHED_SET, ...pubkeys);
  for (const pubkey of pubkeys) {
    pipeline.del(CONTACTS_LAST_INGEST_PREFIX + pubkey);
  }
  await pipeline.exec().catch(() => undefined);
}

async function setNx(redis: Redis, key: string, ttlSeconds: number): Promise<boolean> {
  try {
    return await redis.set(key, '1', 'EX', ttlSeconds, 'NX') === 'OK';
  } catch {
    return false;
  }
}

async function safeDel(redis: Redis, key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    // Best-effort warmup signal.
  }
}

function uniquePubkeys(values: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const pubkey = normalizePubkey(value);
    if (pubkey) out.add(pubkey);
  }
  return Array.from(out);
}

function normalizePubkey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.toLowerCase();
  return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : null;
}
