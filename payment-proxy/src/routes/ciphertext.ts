// /account/nsec-ciphertext (POST/GET/DELETE) — passkey-encrypted nsec
// storage. The server never sees the decryption key — these endpoints
// just move opaque bytes. Writes require NIP-98 (prove you own the
// pubkey before associating ciphertext with it). Reads require a fresh
// passkey assertion token (prevents enumeration of which pubkeys
// have stored ciphertext with us).

import { CIPHERTEXT_MAX_BYTES } from '../ciphertext.js';
import { redeemAssertToken } from '../helpers/assert-token.js';
import type { Deps } from '../route-deps.js';

export function register(deps: Deps): void {
  const { app, ciphertextStore, passkeyStore, redis, rateLimit, requireNip98, PUBLIC_BASE_URL } = deps;

  app.post('/account/nsec-ciphertext', async (request, reply) => {
    if (!ciphertextStore) {
      return reply.status(503).send({ error: 'ciphertext storage not configured' });
    }
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/nsec-ciphertext`,
      'POST',
      { bindBody: true },
    );
    if (!authCheck) return;
    // Per-pubkey cap on overwrites. POSTs replace the slot — there's
    // no fan-out cost — but a buggy client could spray writes and a
    // compromised nsec could blow through the storage quota by
    // toggling content. 30/min is well above any realistic re-encrypt
    // flow (which only fires when the user adds a new passkey or
    // rotates the encryption key).
    const gate = await rateLimit('ciphertext-pk', authCheck.pubkey, 30, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }
    const body = request.body as { ciphertextB64?: string } | undefined;
    if (!body?.ciphertextB64 || typeof body.ciphertextB64 !== 'string') {
      return reply.status(400).send({ error: 'ciphertextB64 required' });
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(body.ciphertextB64, 'base64'));
    } catch {
      return reply.status(400).send({ error: 'invalid base64' });
    }
    if (bytes.byteLength === 0 || bytes.byteLength > CIPHERTEXT_MAX_BYTES) {
      return reply.status(400).send({ error: 'ciphertext size out of range' });
    }
    try {
      await ciphertextStore.put(authCheck.pubkey, bytes);
      return { ok: true };
    } catch (err) {
      app.log.error({ err, pubkey: authCheck.pubkey }, 'ciphertext put failed');
      return reply.status(500).send({ error: 'upstream storage failed' });
    }
  });

  app.get<{ Querystring: { pubkey?: string; token?: string } }>(
    '/account/nsec-ciphertext',
    async (request, reply) => {
      if (!ciphertextStore) {
        return reply.status(503).send({ error: 'ciphertext storage not configured' });
      }
      const { pubkey, token } = request.query;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      if (!token) {
        return reply.status(401).send({ error: 'passkey assertion token required' });
      }
      const ok = await redeemAssertToken(redis, token, pubkey.toLowerCase());
      if (!ok) return reply.status(401).send({ error: 'invalid or expired token' });
      const bytes = await ciphertextStore.get(pubkey.toLowerCase());
      if (!bytes) return reply.status(404).send({ error: 'not found' });
      return { ciphertextB64: Buffer.from(bytes).toString('base64') };
    },
  );

  app.delete('/account/nsec-ciphertext', async (request, reply) => {
    if (!ciphertextStore) {
      return reply.status(503).send({ error: 'ciphertext storage not configured' });
    }
    const authCheck = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/nsec-ciphertext`,
      'DELETE',
    );
    if (!authCheck) return;
    try {
      await ciphertextStore.delete(authCheck.pubkey);
      await passkeyStore.removeAll(authCheck.pubkey);
      return { ok: true };
    } catch (err) {
      app.log.error({ err, pubkey: authCheck.pubkey }, 'ciphertext delete failed');
      return reply.status(500).send({ error: 'upstream storage failed' });
    }
  });
}
