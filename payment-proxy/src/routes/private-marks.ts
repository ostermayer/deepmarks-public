// /private-marks/* — cache-of-NIP-51 endpoints.
//
// The Deepmarks-side copy of a user's private bookmarks is a CACHE of
// their NIP-51 events on Nostr relays, not an independent authority.
// The Nostr event is the source of truth; this store exists so
// email-only sessions can decrypt them client-side with the view key.
//
// - Writes (PUT/DELETE) require NIP-98 (proof of nsec possession)
// - Reads (GET /list) allow any session tier (email or full)
// - Reconcile is a bulk operation that returns a delta the client
//   applies to bring our cache in line with NIP-51 state

import { z } from 'zod';
import type { PrivateMarkCiphertext } from '../account.js';
import type { Deps } from '../route-deps.js';

const PrivateMarkSchema = z.object({
  id: z.string().min(1).max(200),
  ciphertext: z.string().min(1).max(100_000),
  nonce: z.string().min(1).max(64),
  createdAt: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const ReconcilePlanSchema = z.object({
  state: z.array(
    z.object({
      id: z.string().min(1).max(200),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      createdAt: z.number().int().positive(),
    }),
  ).max(5000),
});

export function register(deps: Deps): void {
  const { app, accounts, privateMarks, rateLimit, requireNip98, requireSession, PUBLIC_BASE_URL } = deps;

  // ── PUT /private-marks/:id ──────────────────────────────────────────
  // Upload/update one private-mark ciphertext.
  app.put<{ Params: { id: string }; Body: PrivateMarkCiphertext }>(
    '/private-marks/:id',
    async (request, reply) => {
      // bindBody:true → NIP-98 `payload` tag must match sha256(rawBody).
      // Defends a captured PUT header from being replayed against
      // attacker-chosen ciphertext within the 60s freshness window.
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/private-marks/${request.params.id}`,
        'PUT',
        { bindBody: true },
      );
      if (!authCheck) return;
      // Per-pubkey cap so a buggy client (or compromised nsec) can't
      // spray up to 100 KB blobs into the cache unbounded. 600/min
      // (10/sec) is well above any reasonable interactive sync, well
      // below an exfil/fill rate.
      const gate = await rateLimit('private-marks-put', authCheck.pubkey, 600, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }

      const parsed = PrivateMarkSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid body', details: parsed.error.flatten() });
      }
      if (parsed.data.id !== request.params.id) {
        return reply.status(400).send({ error: 'body.id does not match path' });
      }

      const account = await accounts.getByPubkey(authCheck.pubkey);
      if (!account) return reply.status(404).send({ error: 'no email linked to this pubkey' });

      const outcome = await privateMarks.put(account.emailHash, parsed.data);
      return { ok: true, outcome };
    },
  );

  // ── DELETE /private-marks/:id ───────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/private-marks/:id',
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/private-marks/${request.params.id}`,
        'DELETE',
      );
      if (!authCheck) return;
      const account = await accounts.getByPubkey(authCheck.pubkey);
      if (!account) return reply.status(404).send({ error: 'no email linked to this pubkey' });
      await privateMarks.delete(account.emailHash, request.params.id);
      return { ok: true };
    },
  );

  // ── GET /private-marks ──────────────────────────────────────────────
  // Any session tier can read — email-only users unlock their view
  // key from the sign-in response and decrypt these locally.
  app.get('/private-marks', async (request, reply) => {
    const session = await requireSession(request.headers.authorization);
    if (!session.ok) return reply.status(session.status).send({ error: session.reason });
    const all = await privateMarks.listAll(session.emailHash);
    // Include a sync timestamp for the UI's "last synced" hint.
    return { marks: all, syncedAt: Math.floor(Date.now() / 1000) };
  });

  // ── POST /private-marks/reconcile ───────────────────────────────────
  // Client sends its current NIP-51 state; server returns the delta.
  // Requires a signer (NIP-98) because reconcile is a write-ish
  // operation that could delete ciphertext — only the nsec holder
  // should be able to trigger it.
  app.post(
    '/private-marks/reconcile',
    async (request, reply) => {
      const authCheck = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/private-marks/reconcile`,
        'POST',
        { bindBody: true },
      );
      if (!authCheck) return;
      const parsed = ReconcilePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid body' });
      }
      const account = await accounts.getByPubkey(authCheck.pubkey);
      if (!account) return reply.status(404).send({ error: 'no email linked to this pubkey' });

      const plan = await privateMarks.reconcilePlan(account.emailHash, parsed.data.state);
      // Server auto-deletes orphaned entries so the client only has to
      // PUT the to-upload IDs. Faster convergence, fewer round-trips.
      for (const id of plan.toDelete) {
        await privateMarks.delete(account.emailHash, id);
      }
      return {
        ok: true,
        toUpload: plan.toUpload,
        deleted: plan.toDelete.length,
      };
    },
  );
}
