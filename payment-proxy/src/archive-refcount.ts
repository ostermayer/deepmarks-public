// Cross-user archive blob refcount.
//
// Why: archive blobs are content-addressed (SHA-256 of the bytes). If
// two users archive the same URL and produce byte-identical output, the
// resulting blob lands at the same hash. Before this module the
// per-user delete route called Blossom DELETE unconditionally, which
// meant if User A deleted "their" archive, User B's archive of the
// same URL would silently 404 the next time they tried to view it.
//
// Model:
//
//   dm:archive-refs:<blobHash>  (Redis SET, members = pubkey)
//
// The blob hash is the dedup unit. Private media add-ons are encrypted
// with a fresh per-user key, so the same source video produces distinct
// ciphertext blobs and must not be collapsed by source URL/video id.
//
// Invariants:
//   - addArchiveRef on every successful archive callback (worker
//     completes a job for ownerPubkey).
//   - removeArchiveRef on every user-initiated delete BEFORE physically
//     removing the Blossom blob. If SCARD goes to 0, the caller may
//     destroy the blob; if > 0, the blob stays — another user still
//     references it.
//   - backfillFromExistingArchives runs once at boot to seed the sets
//     from the per-user `dm:archives:<pubkey>` hashes that pre-date
//     this module. Idempotent (SADD).
//
// We deliberately do NOT store any metadata in the set beyond the
// pubkey — keeping it a pure SET means SADD/SREM/SCARD are O(1) and
// no parsing is required to make a delete decision.

import type { Redis } from 'ioredis';

const REFS_PREFIX = 'dm:archive-refs:';
const BACKFILL_DONE_KEY = 'dm:archive-refs:backfill-done:v1';

/** Build the Redis key for a ref key. Public so callers don't
 *  hard-code the prefix and drift from this module. */
export function refsKeyFor(refKey: string): string {
  return `${REFS_PREFIX}${refKey}`;
}

/** Record that `pubkey` references `refKey`. Returns the new
 *  member-count of the set. */
export async function addArchiveRef(
  redis: Redis,
  refKey: string,
  pubkey: string,
): Promise<number> {
  const key = refsKeyFor(refKey);
  await redis.sadd(key, pubkey);
  return redis.scard(key);
}

/** Remove `pubkey` from the ref set. Returns the resulting member
 *  count — caller deletes the underlying blob iff this is 0. */
export async function removeArchiveRef(
  redis: Redis,
  refKey: string,
  pubkey: string,
): Promise<number> {
  const key = refsKeyFor(refKey);
  await redis.srem(key, pubkey);
  return redis.scard(key);
}

/** Pure read of the ref count. */
export async function getArchiveRefCount(
  redis: Redis,
  refKey: string,
): Promise<number> {
  return redis.scard(refsKeyFor(refKey));
}

/** Whether deleting `pubkey`'s reference would leave any other user
 *  pointing at this content. Useful for UX: "you're the last owner —
 *  this blob will be permanently removed". */
export async function isLastReference(
  redis: Redis,
  refKey: string,
  pubkey: string,
): Promise<boolean> {
  const members = await redis.smembers(refsKeyFor(refKey));
  return members.length === 0 || (members.length === 1 && members[0] === pubkey);
}

/**
 * One-shot lazy backfill: scans every `dm:archives:<pubkey>` hash and
 * populates the corresponding `dm:archive-refs:<blobHash>` sets so
 * the very first delete after this module ships doesn't unilaterally
 * destroy a blob that another user also references.
 *
 * Cheap: SCAN cursor + per-key HKEYS. Skips on subsequent boots via a
 * marker key. Safe to call concurrently — SADD is idempotent and
 * the marker is set-NX.
 */
export async function backfillFromExistingArchives(
  redis: Redis,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<void> {
  const claimed = await redis.set(BACKFILL_DONE_KEY, '1', 'NX');
  if (claimed !== 'OK') {
    return; // Already done on a previous boot.
  }

  let cursor = '0';
  let scanned = 0;
  let refsAdded = 0;
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'dm:archives:*', 'COUNT', 200);
      cursor = next;
      for (const archivesKey of keys) {
        // dm:archives:<pubkey> — extract pubkey from the suffix.
        const pubkey = archivesKey.slice('dm:archives:'.length);
        if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
        const blobHashes = await redis.hkeys(archivesKey);
        if (blobHashes.length === 0) continue;
        // Multi-SADD: one round-trip per pubkey, regardless of blob
        // count. With 64-char hex hashes this is small enough that
        // we don't bother chunking.
        const pipeline = redis.multi();
        for (const blobHash of blobHashes) {
          if (!/^[0-9a-f]{64}$/.test(blobHash)) continue;
          pipeline.sadd(refsKeyFor(blobHash), pubkey);
          refsAdded += 1;
        }
        await pipeline.exec().catch((err) => {
          logger.warn({ err, archivesKey }, 'archive-refs backfill: pipeline failed');
        });
        scanned += 1;
      }
    } while (cursor !== '0');
    logger.info({ scanned, refsAdded }, 'archive-refs backfill complete');
  } catch (err) {
    // Don't leave the marker set if we crashed midway — the next
    // boot should retry. Best-effort delete.
    await redis.del(BACKFILL_DONE_KEY).catch(() => undefined);
    logger.warn({ err, scanned, refsAdded }, 'archive-refs backfill aborted — will retry next boot');
  }
}
