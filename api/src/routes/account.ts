// /account/* — non-passkey, non-ciphertext account routes:
//   GET    /account/lifetime/status
//   GET    /account/username-lookup
//   GET    /account/username-of
//   GET    /account/username-available
//   POST   /account/username
//   DELETE /account/username
//   GET    /account/archives
//   GET    /account/archive-queue
//   GET    /account/settings  (+ PUT)
//   DELETE /account
//
// Lifetime invoice creation + the BTCPay webhook live in routes/lifetime.ts.
// Passkey routes live in routes/passkey.ts. Ciphertext routes live in
// routes/ciphertext.ts.

import {
  archiveFilesForRecord,
  compareArchiveRecordsNewest,
  deleteAllArchivesForAccount,
  deletePrimaryArchiveBlobs,
  enqueueArchiveMirrorDelete,
  parseArchiveRecord,
} from '../archive-lifecycle.js';
import { listArchiveFailures } from '../archive-failures.js';
import { removeArchiveRef } from '../archive-refcount.js';
import type { Deps } from '../route-deps.js';
import type { ArchiveFileRecord } from '../types.js';
import { UserSettingsInputSchema } from '../user-settings.js';

export function register(deps: Deps): void {
  const {
    app,
    apiKeys,
    lifetimeStore,
    usernameStore,
    userSettingsStore,
    passkeyStore,
    ciphertextStore,
    requireNip98,
    gateRateLimit,
    PUBLIC_BASE_URL,
  } = deps;

  // ── GET /account/archives ───────────────────────────────────────────
  // NIP-98 sibling of the Bearer-authed GET /api/v1/archives: the web
  // app has no API key, so it lists archives here with a signed NIP-98
  // header instead. Both return the same shape — each reads the
  // dm:archives:<pubkey> hash the worker callback success path writes.
  // Do NOT dedupe into /api/v1 — that would break in-app archive
  // listing for every non-API-key user.
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/account/archives',
    async (request, reply) => {
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/account/archives`,
        'GET',
      );
      if (!auth) return;
      // Cap raised from 500 → 5000 so users with several thousand
      // archives can fetch in one round-trip. Each round-trip costs a
      // NIP-98 sign (which on a NIP-46 bunker is a relay round-trip)
      // — small libraries see no change, large libraries stop
      // hitting NIP-98 replay rejection on the 2nd/3rd page.
      const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 5000);
      const offset = Math.min(Math.max(Number(request.query.offset ?? 0), 0), 50_000);
      const [raw, failures] = await Promise.all([
        deps.redis.hgetall(`dm:archives:${auth.pubkey}`),
        listArchiveFailures(deps.redis, auth.pubkey),
      ]);
      const items: Array<{
        jobId: string;
        url: string;
        originalUrl?: string;
        blobHash: string;
        tier: string;
        source?: string;
        archivedAt: number;
        completedAt?: number;
        bookmarkSavedAt?: number;
        thumbHash?: string;
        contentType?: string;
        fileName?: string;
        kind?: string;
        videoId?: string;
        videoContentKey?: string;
        videoTitle?: string;
        videoChannel?: string;
        videoDurationSeconds?: number;
        files?: ReturnType<typeof archiveFilesForRecord>;
      }> = [];
      for (const [blobHash, json] of Object.entries(raw ?? {})) {
        const rec = parseArchiveRecord(blobHash, json, auth.pubkey);
        if (!rec) continue;
        items.push({
          jobId: rec.jobId,
          url: rec.url,
          originalUrl: rec.originalUrl,
          blobHash: rec.blobHash,
          tier: rec.tier,
          source: rec.source,
          archivedAt: rec.archivedAt,
          completedAt: rec.completedAt,
          bookmarkSavedAt: rec.bookmarkSavedAt,
          thumbHash: rec.thumbHash,
          contentType: rec.contentType,
          fileName: rec.fileName,
          kind: rec.kind,
          videoId: rec.videoId,
          videoContentKey: rec.videoContentKey,
          videoTitle: rec.videoTitle,
          videoChannel: rec.videoChannel,
          videoDurationSeconds: rec.videoDurationSeconds,
          files: archiveFilesForRecord(rec),
        });
      }
      items.sort(compareArchiveRecordsNewest);
      const page = items.slice(offset, offset + limit);
      return { archives: page, count: page.length, total: items.length, failures };
    },
  );

  // ── GET /account/archive-queue — user's pending/running archive jobs ─
  // Cheap diagnostic/status surface for lifetime backfills. The client can
  // have stale local queue markers from older builds, but Redis knows the
  // real server-side backlog.
  app.get('/account/archive-queue', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/archive-queue`,
      'GET',
    );
    if (!auth) return;
    const [pending, running, archivedTotal] = await Promise.all([
      countArchiveQueueOwner(deps.redis, auth.pubkey),
      countArchiveProcessingOwner(deps.redis, auth.pubkey),
      deps.redis.hlen(`dm:archives:${auth.pubkey}`),
    ]);
    return {
      pending: pending.total,
      running: running.total,
      archivedTotal,
      mediaPending: pending.media,
      mediaRunning: running.media,
    };
  });

  // ── GET/PUT /account/settings — cross-client app preferences ───────
  // This is intentionally Deepmarks-server coordinated rather than
  // relay-coordinated: non-secret settings need predictable
  // last-write-wins sync across web, mobile, and extensions. The
  // document excludes secrets and signer grants. NWC sync uses a
  // separate self-encrypted kind:30003 record so the server never sees
  // a usable wallet credential.
  app.get('/account/settings', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/settings`,
      'GET',
    );
    if (!auth) return;
    return userSettingsStore.get(auth.pubkey);
  });

  app.put('/account/settings', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/settings`,
      'PUT',
      { bindBody: true },
    );
    if (!auth) return;
    const parsed = UserSettingsInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    return userSettingsStore.put(auth.pubkey, parsed.data);
  });

  // ── DELETE /account/archives/:blobHash — wipe MY archive ────────────
  // NIP-98-gated. Two-step teardown:
  //   1. HDEL the entry from dm:archives:<authPubkey> so it disappears
  //      from the user's list and /account/archives stops returning it.
  //   2. S3 deleteObject from the Blossom bucket so blossom.deepmarks.org
  //      starts 404ing for the hash.
  //   3. Enqueue signed BUD-01 DELETE requests for known mirror copies.
  // Mirror deletion is best-effort because remote Blossom servers decide
  // whether to honor the worker's delete auth, but we do actively ask.
  //
  // Idempotent: deleting a not-found archive returns 404 from the entry-
  // list step (we don't touch S3 in that case to avoid charging the
  // primary deletion to a pubkey that doesn't own it).
  app.delete<{ Params: { blobHash: string } }>(
    '/account/archives/:blobHash',
    async (request, reply) => {
      const blobHash = request.params.blobHash.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(blobHash)) {
        return reply.status(400).send({ error: 'blobHash must be 64 hex chars' });
      }
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/account/archives/${blobHash}`,
        'DELETE',
      );
      if (!auth) return;

      // Verify the caller actually owns this archive. Without this an
      // arbitrary nsec holder could DELETE any other user's blob from
      // the primary just by knowing the hash — content-addressed
      // storage doesn't carry per-blob ownership at the bucket level.
      const entry = await deps.redis.hget(`dm:archives:${auth.pubkey}`, blobHash);
      if (!entry) {
        return reply.status(404).send({ error: 'archive not in your account' });
      }
      const parsed = parseArchiveRecord(blobHash, entry, auth.pubkey) ?? {
        jobId: '',
        ownerPubkey: auth.pubkey,
        url: '',
        blobHash,
        tier: 'unknown',
        archivedAt: 0,
      };

      // Step 1 — drop from the user's archive list.
      await deps.redis.hdel(`dm:archives:${auth.pubkey}`, blobHash);

      // Step 2 — decrement the cross-user refcount on the actual stored
      // bytes. Media archives are private ciphertext encrypted with a
      // per-user key, so source-level video ids are metadata, not delete
      // pivots.
      const files = archiveFilesForRecord(parsed);
      const filesToDelete: ArchiveFileRecord[] = [];
      let remaining = 0;
      for (const file of files) {
        const fileRemaining = await removeArchiveRef(deps.redis, file.blobHash, auth.pubkey);
        if (fileRemaining === 0) filesToDelete.push(file);
        if (file.blobHash === blobHash) remaining = fileRemaining;
      }

      // Step 3 — best-effort S3 teardown of our primary copy, including
      // any public screenshot thumbnail. ONLY when no one else still
      // references it.
      let primary: { primaryDeleted: boolean; errors: string[] } = { primaryDeleted: false, errors: [] };
      let mirrorDeleteQueued = false;
      if (filesToDelete.length > 0) {
        primary = await deletePrimaryArchiveBlobs(deps.blossomBlobStore, {
          ...parsed,
          blobHash: filesToDelete[0]!.blobHash,
          files: filesToDelete,
        });
        for (const err of primary.errors) {
          app.log.warn({ blobHash, err }, 'archive primary delete warning');
        }
        // Step 4 — known mirror teardown via the archive-worker, which
        // owns the Blossom signing key that uploaded/mirrored the bytes.
        for (const file of filesToDelete) {
          const queued = await enqueueArchiveMirrorDelete(
            deps.redis,
            {
              ...parsed,
              blobHash: file.blobHash,
              mirrors: file.mirrors ?? parsed.mirrors,
            },
            'archive-delete',
          );
          mirrorDeleteQueued ||= queued;
        }
      } else {
        app.log.info(
          { blobHash, remaining },
          'archive ref removed but blob retained for other users',
        );
      }

      return {
        ok: true,
        blobHash,
        url: parsed.url,
        tier: parsed.tier,
        primaryDeleted: primary.primaryDeleted,
        primaryError: primary.errors[0],
        mirrorDeleteQueued,
        sharedReferences: remaining,
      };
    },
  );

  // ── GET /account/lifetime/status ────────────────────────────────────
  // Cheap pubkey-only check used by the upgrade page to show "already a
  // member" vs "upgrade now" state. No auth needed since the status of
  // a given pubkey is already public (it's stamped by a settled invoice
  // that the rest of Nostr can also observe).
  app.get<{ Querystring: { pubkey?: string } }>(
    '/account/lifetime/status',
    async (request, reply) => {
      // Per-IP cap: unauthenticated lookup, scrapeable for member
      // enumeration. 60/min is plenty for legitimate UI polling.
      if (!(await gateRateLimit(reply, 'lifetime-status-ip', request.ip, 60, 60))) return reply;
      const pubkey = request.query.pubkey;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'pubkey query param required (hex)' });
      }
      const paid = await lifetimeStore.isPaid(pubkey);
      const paidAt = paid ? await lifetimeStore.paidAt(pubkey) : null;
      return { pubkey, isLifetimeMember: paid, paidAt };
    },
  );

  // ── Deepmarks short usernames (lifetime-tier perk) ──────────────────
  // Lifetime members can claim a short handle → /u/<name> routes resolve
  // to their npub. Non-members only have /u/<npub1…>. Handle state lives
  // in Redis; the npub is the true identity and never changes.

  app.get<{ Querystring: { name?: string } }>(
    '/account/username-lookup',
    async (request, reply) => {
      if (!(await gateRateLimit(reply, 'username-read-ip', request.ip, 120, 60))) return reply;
      const raw = (request.query.name ?? '').trim().toLowerCase();
      if (!raw) return reply.status(400).send({ error: 'name query param required' });
      const pubkey = await usernameStore.lookup(raw);
      if (!pubkey) return reply.status(404).send({ error: 'not found' });
      return { name: raw, pubkey };
    },
  );

  app.get<{ Querystring: { pubkey?: string } }>(
    '/account/username-of',
    async (request, reply) => {
      if (!(await gateRateLimit(reply, 'username-read-ip', request.ip, 120, 60))) return reply;
      const pubkey = request.query.pubkey;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'pubkey query param required (hex)' });
      }
      const name = await usernameStore.usernameOf(pubkey.toLowerCase());
      if (!name) return reply.status(404).send({ error: 'not found' });
      return { name, pubkey: pubkey.toLowerCase() };
    },
  );

  // Cheap availability check the claim UI can poll as the user types.
  // Same validation the POST does, but safe to hit without auth.
  app.get<{ Querystring: { name?: string } }>(
    '/account/username-available',
    async (request, reply) => {
      // Distinct bucket from the lookup/of routes so the live-as-you-type
      // claim UI doesn't burn through the read budget on neighboring calls.
      if (!(await gateRateLimit(reply, 'username-avail-ip', request.ip, 240, 60))) return reply;
      const raw = (request.query.name ?? '').trim().toLowerCase();
      if (!raw) return reply.status(400).send({ error: 'name query param required' });
      return usernameStore.check(raw);
    },
  );

  app.post('/account/username', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/username`,
      'POST',
      { bindBody: true },
    );
    if (!authCheck) return;
    const pubkey = authCheck.pubkey;
    const body = (request.body ?? {}) as { name?: string };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ error: 'name required' });
    }
    const isLifetime = await lifetimeStore.isPaid(pubkey);
    const result = await usernameStore.claim(pubkey, body.name, isLifetime);
    if (!result.ok) {
      const status = result.error === 'not-lifetime' ? 402 : 409;
      return reply.status(status).send({ error: result.error });
    }
    app.log.info({ pubkey, name: result.name }, 'username claimed');
    return { name: result.name, pubkey };
  });

  app.delete('/account/username', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/username`,
      'DELETE',
    );
    if (!authCheck) return;
    const pubkey = authCheck.pubkey;
    const { released } = await usernameStore.release(pubkey);
    if (released) app.log.info({ pubkey, name: released }, 'username released');
    return { released };
  });

  // ── DELETE /account ─────────────────────────────────────────────────
  // Tombstone every piece of user state keyed on the authed pubkey:
  //   • Release their short deepmarks handle (normal cooldown skipped
  //     for lifetime deletions so someone else can claim it immediately)
  //   • Revoke all API keys
  //   • Delete owned archive blobs from primary storage and enqueue
  //     best-effort deletes for known Blossom mirrors
  //
  // Lifetime-payment record is intentionally preserved: the user paid for
  // a lifetime tier tied to their pubkey and can still reclaim it by
  // signing back in with the same nsec. The Nostr-side deletion (kind:5
  // requests against the user's own bookmark events) is the frontend's
  // job — the user's signer has to sign them, not ours.
  app.delete('/account', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account`,
      'DELETE',
    );
    if (!authCheck) return;
    const pubkey = authCheck.pubkey;

    const wasLifetime = await lifetimeStore.isPaid(pubkey);
    const { released } = await usernameStore.release(pubkey, { cooldown: !wasLifetime });
    const settingsRemoved = await userSettingsStore.delete(pubkey);
    const archiveCleanup = await deleteAllArchivesForAccount({
      redis: deps.redis,
      blobStore: deps.blossomBlobStore,
      pubkey,
    });
    const { revoked } = await apiKeys.revokeAll(pubkey);
    const { removed: passkeysRemoved } = await passkeyStore.removeAll(pubkey);
    let ciphertextRemoved = false;
    if (ciphertextStore) {
      try {
        await ciphertextStore.delete(pubkey);
        ciphertextRemoved = true;
      } catch (err) {
        app.log.warn({ err, pubkey }, 'ciphertext delete on account tombstone failed');
      }
    }

    app.log.info(
      {
        pubkey,
        released,
        releasedUsernameCooldown: !wasLifetime,
        revoked,
        passkeysRemoved,
        ciphertextRemoved,
        archiveCleanup,
        settingsRemoved,
      },
      'account deleted',
    );

    return {
      ok: true,
      releasedUsername: released,
      revokedApiKeys: revoked,
      // Compatibility constants: shipped clients (native 2.2.13 and
      // earlier web bundles) validate the response with a schema that
      // REQUIRES these two email-era fields — dropping them outright
      // made every account deletion error client-side AFTER the server
      // tombstoned (2026-08-23 cleanup review #1). Remove once no
      // pre-2.2.14 client remains in the wild.
      privateMarksRemoved: 0,
      hadAccount: false,
      passkeysRemoved,
      ciphertextRemoved,
      archivesRemoved: archiveCleanup.archivesRemoved,
      archivePrimaryDeleted: archiveCleanup.primaryDeleted,
      archiveThumbsDeleted: archiveCleanup.thumbDeleted,
      archiveMirrorDeleteJobs: archiveCleanup.mirrorDeleteJobs,
      archiveDeleteErrors: archiveCleanup.errors,
      releasedUsernameCooldown: !wasLifetime,
      settingsRemoved,
    };
  });

}

async function countArchiveQueueOwner(
  redis: Deps['redis'],
  pubkey: string,
): Promise<ArchiveJobCounts> {
  const items = await redis.lrange('dm:archive:queue', 0, -1);
  return countOwnerInArchiveJobJson(items, pubkey);
}

async function countArchiveProcessingOwner(
  redis: Deps['redis'],
  pubkey: string,
): Promise<ArchiveJobCounts> {
  let cursor = '0';
  const total: ArchiveJobCounts = { total: 0, media: 0 };
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      'dm:archive:processing:*',
      'COUNT',
      100,
    );
    cursor = next;
    for (const key of keys) {
      const counts = countOwnerInArchiveJobJson(await redis.lrange(key, 0, -1), pubkey);
      total.total += counts.total;
      total.media += counts.media;
    }
  } while (cursor !== '0');
  return total;
}

interface ArchiveJobCounts {
  total: number;
  media: number;
}

function countOwnerInArchiveJobJson(items: string[], pubkey: string): ArchiveJobCounts {
  const count: ArchiveJobCounts = { total: 0, media: 0 };
  for (const raw of items) {
    try {
      const job = JSON.parse(raw) as { ownerPubkey?: unknown; kind?: unknown };
      if (job.ownerPubkey === pubkey) {
        count.total += 1;
        const kind = typeof job.kind === 'string' ? job.kind.toLowerCase() : '';
        if (kind === 'media' || kind === 'video' || kind === 'youtube') count.media += 1;
      }
    } catch {
      // Corrupt queue entries are ignored; the worker's queue recovery
      // path drops them separately.
    }
  }
  return count;
}
