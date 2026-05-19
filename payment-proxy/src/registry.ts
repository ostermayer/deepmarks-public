// Registered-pubkey registry — Redis set of every pubkey that has
// authenticated with Deepmarks. The strfry writePolicy plugin reads
// from this set to decide whether to accept a write.
//
// Auto-populated by:
//   - successful NIP-98 auth on any API route (helpers/auth-gate.ts)
//   - lifetimeStore.markPaid (lifetime.ts)
//   - usernameStore.claim (username.ts)
//   - cachePublicBookmarkEvent for events whose author is fresh
//     (public-bookmark-cache.ts)
//
// One-time backfill on worker startup pulls every existing
// lifetime-member + username claimant into the set so existing users
// don't suddenly get rejected after this lands.

import type { Redis } from 'ioredis';

const KEY = 'dm:registered:pubkeys';
/** Module-level positive cache: avoids round-tripping Redis for the
 *  same pubkey N times within a single request lifetime. Negative
 *  entries cache for a short window so a just-registered pubkey
 *  doesn't stay rejected for long. */
const cache = new Map<string, { registered: boolean; expiresAt: number }>();
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 1000;

/** Queue key the onboarding-scanner worker pops from. LPUSH on first
 *  registration triggers a one-time scan of the user's NIP-65 relays
 *  for events they've already published from other clients. */
const ONBOARDING_QUEUE = 'dm:onboarding:queue';
/** Queue key the lifetime-archive-backfill worker pops from. LPUSH
 *  on lifetime markPaid → enqueue archive jobs for the user's
 *  existing public bookmarks. */
export const LIFETIME_ARCHIVE_QUEUE = 'dm:lifetime-archive:queue';

export async function registerPubkey(redis: Redis, pubkey: string): Promise<void> {
  if (!isHexPubkey(pubkey)) return;
  const lc = pubkey.toLowerCase();
  // Cheap fast-path: if we know it's already registered, skip the SADD.
  const cached = cache.get(lc);
  if (cached?.registered && cached.expiresAt > Date.now()) return;
  try {
    const result = await redis.sadd(KEY, lc);
    cache.set(lc, { registered: true, expiresAt: Date.now() + POSITIVE_TTL_MS });
    if (result === 1) {
      // First-ever registration for this pubkey → schedule the
      // onboarding scan. LPUSH instead of running inline so a slow
      // relay query doesn't block the auth path.
      await redis.lpush(ONBOARDING_QUEUE, lc).catch(() => undefined);
    }
  } catch {
    // Best-effort. Strfry's plugin fails open on Redis errors, so a
    // single SADD miss isn't catastrophic — the next interaction
    // will retry.
  }
}

/** Schedule an onboarding scan to run again for a pubkey that's
 *  already been registered. Clears the dedup marker the scanner
 *  uses so it doesn't bail. Used by the /account/contacts route to
 *  recover when a user signed in before the kind:3 import landed —
 *  their cache is empty until the scanner re-runs. */
export async function enqueueOnboardingScan(redis: Redis, pubkey: string): Promise<void> {
  if (!isHexPubkey(pubkey)) return;
  const lc = pubkey.toLowerCase();
  try {
    await redis.del(`dm:onboarding:done:${lc}`);
    await redis.lpush(ONBOARDING_QUEUE, lc);
  } catch {
    // Best-effort — the next interaction will try again.
  }
}

export async function isRegistered(redis: Redis, pubkey: string): Promise<boolean> {
  if (!isHexPubkey(pubkey)) return false;
  const lc = pubkey.toLowerCase();
  const cached = cache.get(lc);
  if (cached && cached.expiresAt > Date.now()) return cached.registered;
  try {
    const result = await redis.sismember(KEY, lc);
    const registered = result === 1;
    cache.set(lc, {
      registered,
      expiresAt: Date.now() + (registered ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
    return registered;
  } catch {
    return false;
  }
}

export async function countRegistered(redis: Redis): Promise<number> {
  try { return await redis.scard(KEY); } catch { return 0; }
}

/**
 * One-time backfill — pull every pubkey we already consider a user
 * into the registry set so existing lifetime members + username
 * claimants don't suddenly get rejected by the relay's writePolicy
 * after this lands. Safe to run on every boot: SADD is idempotent.
 *
 * Sources:
 *   - lifetime members (dm:lifetime:<pubkey>)
 *   - username claimants (dm:username:bypubkey hash)
 *   - cached public-bookmark authors (dm:public-bookmarks:author:*)
 */
export async function backfillRegistry(redis: Redis, logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }): Promise<void> {
  let added = 0;
  // dm:lifetime:<pubkey> — iterate via SCAN
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'dm:lifetime:*', 'COUNT', 500);
      cursor = next;
      for (const k of keys) {
        const pk = k.slice('dm:lifetime:'.length);
        if (/^[0-9a-f]{64}$/i.test(pk)) {
          const n = await redis.sadd(KEY, pk.toLowerCase());
          added += n;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err }, 'registry backfill: lifetime scan failed');
  }
  // dm:username:bypubkey — single hash, fields are pubkeys
  try {
    const fields = await redis.hkeys('dm:username:bypubkey');
    for (const pk of fields) {
      if (/^[0-9a-f]{64}$/i.test(pk)) {
        const n = await redis.sadd(KEY, pk.toLowerCase());
        added += n;
      }
    }
  } catch (err) {
    logger.error({ err }, 'registry backfill: username scan failed');
  }
  // dm:public-bookmarks:author:<pubkey> — anyone we've cached
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'dm:public-bookmarks:author:*', 'COUNT', 500);
      cursor = next;
      for (const k of keys) {
        const pk = k.slice('dm:public-bookmarks:author:'.length);
        if (/^[0-9a-f]{64}$/i.test(pk)) {
          const n = await redis.sadd(KEY, pk.toLowerCase());
          added += n;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err }, 'registry backfill: public-bookmarks scan failed');
  }
  const total = await countRegistered(redis);
  logger.info({ added, total }, 'registry backfill complete');
}

function isHexPubkey(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}
