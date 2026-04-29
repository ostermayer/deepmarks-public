// /account/passkey/* — WebAuthn registration + assertion endpoints.
//
// Two flows:
//
//   "remember nsec on this device":
//     1. POST /account/passkey/register-challenge  → { options }
//     2. browser runs navigator.credentials.create({ ...options, extensions: { prf: { eval } } })
//     3. POST /account/passkey/register  body: { response, label? }
//     4. browser encrypts nsec with PRF-derived key, POST ciphertext
//
//   "sign in with passkey" after a cache clear / new device:
//     1. POST /account/passkey/assert-challenge  → { options }
//        (or /assert-challenge-discoverable when the client doesn't know the npub yet)
//     2. browser runs navigator.credentials.get({ ...options, extensions: { prf: { eval } } })
//     3. POST /account/passkey/assert  body: { response }   — sets an ephemeral token on the session
//     4. GET  /account/nsec-ciphertext  → ciphertext        — gated by the token above
//     5. browser decrypts with PRF output, nsec is live in JS memory
//
// The server never sees the decryption key — PRF output never leaves
// the browser. We only verify WebAuthn assertions to gate who can
// fetch the ciphertext for a given pubkey.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../route-deps.js';
import {
  ASSERT_TOKEN_TTL_SECONDS,
  issueAssertToken,
} from '../helpers/assert-token.js';

export function register(deps: Deps): void {
  const { app, passkeyStore, redis, rateLimit, requireNip98, PUBLIC_BASE_URL } = deps;

  /** Per-IP gate shared by every passkey endpoint that doesn't already
   *  have one. WebAuthn challenge generation and assertion verification
   *  are unauthenticated (anyone can call them with any pubkey), so
   *  without a per-IP cap an attacker can:
   *    - enumerate which pubkeys have passkeys (challenge succeeds vs 404),
   *    - DoS Redis by spamming challenge issuance,
   *    - DoS the CPU by spamming WebAuthn signature verification.
   *  60/min is well above any realistic interactive flow. */
  async function passkeyIpGate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const gate = await rateLimit('passkey-ip', request.ip, 60, 60);
    if (gate.ok) return true;
    reply.header('Retry-After', String(gate.retryAfter));
    reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    return false;
  }

  app.post<{ Body: { pubkey?: string } }>(
    '/account/passkey/register-challenge',
    async (request, reply) => {
      if (!(await passkeyIpGate(request, reply))) return;
      const pubkey = request.body?.pubkey;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      try {
        const options = await passkeyStore.startRegistration(pubkey.toLowerCase());
        return { options };
      } catch (err) {
        app.log.warn({ err }, 'passkey register-challenge failed');
        return reply.status(500).send({ error: 'registration challenge failed' });
      }
    },
  );

  // Register binds a passkey to a pubkey. Without a NIP-98 proof of
  // nsec possession, anyone who knows a pubkey could attach their own
  // authenticator to it. They couldn't decrypt the existing ciphertext
  // (encrypted under the legitimate owner's PRF), but they could:
  //   - pollute the owner's passkey list with attacker-owned creds,
  //   - get an assertToken for the pubkey (which then lets them
  //     download the ciphertext blob — useless for them, but a metadata
  //     leak about which accounts have stored ciphertext with us).
  // Require NIP-98 so registration is gated on holding the nsec.
  app.post<{ Body: { pubkey?: string; response?: unknown; label?: string } }>(
    '/account/passkey/register',
    async (request, reply) => {
      if (!(await passkeyIpGate(request, reply))) return;
      const auth = await requireNip98(
        request,
        reply,
        `${PUBLIC_BASE_URL}/account/passkey/register`,
        'POST',
        { bindBody: true },
      );
      if (!auth) return;
      const { pubkey, response, label } = request.body ?? {};
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      // Body-claimed pubkey must match the NIP-98-signed pubkey so a
      // signed event for pubkey A can't be replayed to register a
      // passkey for pubkey B.
      if (pubkey.toLowerCase() !== auth.pubkey) {
        return reply.status(403).send({ error: 'body pubkey does not match auth pubkey' });
      }
      if (!response || typeof response !== 'object') {
        return reply.status(400).send({ error: 'response required' });
      }
      try {
        const res = await passkeyStore.finishRegistration(
          pubkey.toLowerCase(),
          response as Parameters<typeof passkeyStore.finishRegistration>[1],
          typeof label === 'string' ? label.slice(0, 80) : undefined,
        );
        return { credentialID: res.credentialID };
      } catch (err) {
        app.log.warn({ err }, 'passkey register failed');
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { pubkey?: string } }>(
    '/account/passkey/assert-challenge',
    async (request, reply) => {
      if (!(await passkeyIpGate(request, reply))) return;
      const pubkey = request.body?.pubkey;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      try {
        const options = await passkeyStore.startAuthentication(pubkey.toLowerCase());
        return { options };
      } catch (err) {
        return reply.status(404).send({ error: 'no passkeys registered' });
      }
    },
  );

  app.post<{ Body: { pubkey?: string; response?: unknown } }>(
    '/account/passkey/assert',
    async (request, reply) => {
      if (!(await passkeyIpGate(request, reply))) return;
      const { pubkey, response } = request.body ?? {};
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      if (!response || typeof response !== 'object') {
        return reply.status(400).send({ error: 'response required' });
      }
      const ok = await passkeyStore.finishAuthentication(
        pubkey.toLowerCase(),
        response as Parameters<typeof passkeyStore.finishAuthentication>[1],
      );
      if (!ok) return reply.status(401).send({ error: 'assertion failed' });
      const token = await issueAssertToken(redis, pubkey.toLowerCase());
      return { token, expiresInSeconds: ASSERT_TOKEN_TTL_SECONDS };
    },
  );

  // Discoverable-credential login: client calls these instead of the
  // pubkey-keyed assert-challenge / assert when it doesn't know the
  // user's npub yet (the OS passkey picker tells us who they are).
  app.post('/account/passkey/assert-challenge-discoverable', async (request, reply) => {
    if (!(await passkeyIpGate(request, reply))) return;
    try {
      const options = await passkeyStore.startDiscoverableAuthentication();
      return { options };
    } catch (err) {
      app.log.warn({ err }, 'discoverable assert-challenge failed');
      return reply.status(500).send({ error: 'challenge failed' });
    }
  });

  app.post<{ Body: { response?: unknown } }>(
    '/account/passkey/assert-discoverable',
    async (request, reply) => {
      if (!(await passkeyIpGate(request, reply))) return;
      const response = request.body?.response;
      if (!response || typeof response !== 'object') {
        return reply.status(400).send({ error: 'response required' });
      }
      const result = await passkeyStore.finishDiscoverableAuthentication(
        response as Parameters<typeof passkeyStore.finishDiscoverableAuthentication>[0],
      );
      if (!result.verified || !result.pubkey) {
        return reply.status(401).send({ error: 'assertion failed' });
      }
      const token = await issueAssertToken(redis, result.pubkey);
      return { token, pubkey: result.pubkey, expiresInSeconds: ASSERT_TOKEN_TTL_SECONDS };
    },
  );

  // Public check — does this pubkey have any passkey registered? The
  // login page uses this to decide whether to offer "sign in with
  // passkey" or go straight to nsec paste / extension / bunker.
  app.get<{ Querystring: { pubkey?: string } }>(
    '/account/passkey/exists',
    async (request, reply) => {
      const pubkey = request.query.pubkey;
      if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return reply.status(400).send({ error: 'hex pubkey required' });
      }
      // Throttle to prevent enumeration of which pubkeys have stored
      // passkey-encrypted nsecs with us. The check itself is cheap, but
      // the answer is a privacy signal worth bounding.
      const gate = await rateLimit('passkey-exists', request.ip, 60, 60);
      if (!gate.ok) {
        reply.header('Retry-After', String(gate.retryAfter));
        return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
      }
      const exists = await passkeyStore.hasPasskey(pubkey.toLowerCase());
      return { exists };
    },
  );
}
