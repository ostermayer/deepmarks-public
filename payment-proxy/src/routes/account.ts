// /account/* — non-passkey, non-ciphertext account routes:
//   GET    /account/me
//   GET    /account/lifetime/status
//   GET    /account/username-lookup
//   GET    /account/username-of
//   GET    /account/username-available
//   POST   /account/username
//   DELETE /account/username
//   POST   /account/rotate-pubkey
//   DELETE /account
//
// Lifetime invoice creation + the BTCPay webhook live in routes/lifetime.ts.
// Passkey routes live in routes/passkey.ts. Ciphertext routes live in
// routes/ciphertext.ts.

import { issueSessionToken } from '../auth.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const {
    app,
    accounts,
    privateMarks,
    apiKeys,
    lifetimeStore,
    usernameStore,
    passkeyStore,
    ciphertextStore,
    requireSession,
    requireNip98,
    rateLimit,
    PUBLIC_BASE_URL,
  } = deps;

  // ── GET /account/me ─────────────────────────────────────────────────
  app.get('/account/me', async (request, reply) => {
    const session = await requireSession(request.headers.authorization);
    if (!session.ok) return reply.status(session.status).send({ error: session.reason });
    return {
      pubkey: session.pubkey,
      emailHash: session.emailHash,
      tier: session.tier,
    };
  });

  // ── GET /account/archives — list MY shipped archives ────────────────
  // NIP-98-gated sibling of GET /api/v1/archives. Bearer route is
  // lifetime-only because Bearer keys are lifetime-only; NIP-98 is the
  // path for any nsec holder (including non-lifetime users who paid for
  // individual archives) to see what they've archived. Same data shape
  // either way — both read the dm:archives:<pubkey> hash that the
  // worker callback success path writes.
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
      const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 500);
      const offset = Math.min(Math.max(Number(request.query.offset ?? 0), 0), 10_000);
      const raw = await deps.redis.hgetall(`dm:archives:${auth.pubkey}`);
      const items: Array<{
        jobId: string;
        url: string;
        blobHash: string;
        tier: string;
        source?: string;
        archivedAt: number;
        thumbHash?: string;
      }> = [];
      for (const [blobHash, json] of Object.entries(raw ?? {})) {
        try {
          const rec = JSON.parse(json) as {
            jobId?: string; url?: string; blobHash?: string;
            tier?: string; source?: string; archivedAt?: number;
            ownerPubkey?: string; thumbHash?: string;
          };
          if (rec.ownerPubkey && rec.ownerPubkey !== auth.pubkey) continue;
          items.push({
            jobId: rec.jobId ?? '',
            url: rec.url ?? '',
            blobHash: rec.blobHash ?? blobHash,
            tier: rec.tier ?? 'unknown',
            source: rec.source,
            archivedAt: rec.archivedAt ?? 0,
            thumbHash: rec.thumbHash,
          });
        } catch {
          // skip corrupt entry — never crash the list handler
        }
      }
      items.sort((a, b) => b.archivedAt - a.archivedAt);
      const page = items.slice(offset, offset + limit);
      return { archives: page, count: page.length, total: items.length };
    },
  );

  // ── DELETE /account/archives/:blobHash — wipe MY archive ────────────
  // NIP-98-gated. Two-step teardown:
  //   1. HDEL the entry from dm:archives:<authPubkey> so it disappears
  //      from the user's list and /account/archives stops returning it.
  //   2. S3 deleteObject from the Blossom bucket so blossom.deepmarks.org
  //      starts 404ing for the hash.
  // Mirrors (Primal, Satellite CDN, hzrd149) are out of our reach — they
  // pulled the bytes via BUD-04 at upload time and host independently.
  // The response body explicitly states whether the primary delete
  // succeeded so the client can render an honest "removed from your
  // account; mirror copies may persist" message.
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
      let parsed: { url?: string; tier?: string; thumbHash?: string };
      try { parsed = JSON.parse(entry); }
      catch { parsed = {}; }

      // Step 1 — drop from the user's archive list.
      await deps.redis.hdel(`dm:archives:${auth.pubkey}`, blobHash);

      // Step 2 — best-effort S3 teardown of our primary copy. Includes
      // the screenshot thumbnail when one exists; otherwise we'd
      // orphan thumb blobs in the bucket every time a user deletes.
      let primaryDeleted = false;
      let primaryError: string | undefined;
      if (deps.blossomBlobStore) {
        try {
          await deps.blossomBlobStore.delete(blobHash);
          if (parsed.thumbHash) {
            await deps.blossomBlobStore.delete(parsed.thumbHash).catch((err) => {
              // Thumbnail delete failure shouldn't fail the whole op —
              // the main archive is gone, the thumb just orphans.
              app.log.warn({ thumbHash: parsed.thumbHash, err }, 'thumbnail delete failed; orphaned in bucket');
            });
          }
          primaryDeleted = true;
        } catch (err) {
          primaryError = (err as Error).message ?? 'unknown error';
          app.log.error({ blobHash, err }, 'blossom blob delete failed');
        }
      } else {
        primaryError = 'blossom delete not configured on this server';
      }

      return {
        ok: true,
        blobHash,
        url: parsed.url,
        tier: parsed.tier,
        primaryDeleted,
        primaryError,
        // The mirror caveat is part of the response so any client
        // (extension, web app, future API consumer) renders the same
        // truthful message instead of pretending the snapshot is gone
        // everywhere.
        mirrorsRetained: true,
        mirrorNote: parsed.tier === 'private'
          ? 'Mirrors still host the ciphertext. Wipe the archive key from your NIP-51 set and local cache to make those copies unreadable.'
          : 'Public archives can still be fetched from mirror operators (Primal, Satellite CDN, hzrd149). The hash is content-addressed and effectively permanent once mirrored.',
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
      const gate = await rateLimit('lifetime-status-ip', request.ip, 60, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
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
      const gate = await rateLimit('username-read-ip', request.ip, 120, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
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
      const gate = await rateLimit('username-read-ip', request.ip, 120, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
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
      const gate = await rateLimit('username-avail-ip', request.ip, 240, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
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
  //   • Release their short deepmarks handle (→ 30-day cooldown)
  //   • Revoke all API keys
  //   • Drop private-mark ciphertexts (cached NIP-51 state)
  //   • Forget the AccountStore record (email hash, encrypted view key)
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

    const { released } = await usernameStore.release(pubkey);
    const { revoked } = await apiKeys.revokeAll(pubkey);
    const { deletedEmailHash } = await accounts.deleteByPubkey(pubkey);
    const privateMarksRemoved = deletedEmailHash
      ? (await privateMarks.deleteAllByEmailHash(deletedEmailHash)).removed
      : 0;
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
      { pubkey, released, revoked, privateMarksRemoved, passkeysRemoved, ciphertextRemoved, hadAccount: !!deletedEmailHash },
      'account deleted',
    );

    return {
      ok: true,
      releasedUsername: released,
      revokedApiKeys: revoked,
      privateMarksRemoved,
      passkeysRemoved,
      ciphertextRemoved,
      hadAccount: !!deletedEmailHash,
    };
  });

  // ── POST /account/rotate-pubkey ─────────────────────────────────────
  // User rotated their nsec. NIP-98 proves possession of the NEW key;
  // x-session header with the current session token is the second
  // factor so random attackers can't hijack an email. Bumps
  // session_version, invalidating all existing JWTs on this account.
  app.post('/account/rotate-pubkey', async (request, reply) => {
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/rotate-pubkey`,
      'POST',
    );
    if (!authCheck) return;

    const sessionHeader = request.headers['x-session'];
    const sessionToken = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const session = sessionToken
      ? await requireSession(`Bearer ${sessionToken}`)
      : { ok: false as const, status: 401, reason: 'missing x-session header' };
    if (!session.ok) return reply.status(session.status).send({ error: session.reason });

    const rotated = await accounts.rotatePubkey(session.emailHash, authCheck.pubkey);
    const newToken = issueSessionToken(
      rotated.pubkey,
      rotated.emailHash,
      rotated.sessionVersion,
      'full',
    );
    app.log.info(
      { oldPubkey: session.pubkey, newPubkey: authCheck.pubkey, version: rotated.sessionVersion },
      'pubkey rotated — all prior sessions invalidated',
    );
    return { ok: true, token: newToken, pubkey: authCheck.pubkey };
  });
}
