// /profile/:pubkey — cached kind:0 profile metadata.
//
// Why a server-cached endpoint when each client can already fetch
// kind:0 directly from a relay? Because Primal-style instant avatars +
// display names need a fast, geo-distributable HTTP path. Each
// signed-in mobile/web client otherwise opens N WebSocket subs to
// resolve N curators on first paint of a feed.
//
// Cache shape:
//   `dm:profile-event:<pubkey>` → JSON { content, created_at }
//     populated by ProfileResolver as kind:0 events stream in, and
//     primed here on-demand for pubkeys we haven't seen yet.
//
// On miss we do a one-shot relay query (1.5s timeout) and cache the
// result. Empty/no-profile responses are negatively cached for 5
// minutes so we don't hammer the relay on every paint of a curator
// who hasn't set a profile.

import { queryRelaysWithTimeout } from '../api-helpers.js';
import type { Deps } from '../route-deps.js';

const POSITIVE_TTL = 7 * 24 * 60 * 60; // 7 days
const NEGATIVE_TTL = 5 * 60; // 5 min
const RELAY_TIMEOUT_MS = 1_500;

interface ProfileResponse {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  lud16?: string;
  lud06?: string;
  nip05?: string;
  website?: string;
  /** Unix seconds — created_at of the kind:0 we read. Null when none found. */
  updatedAt: number | null;
}

export function register(deps: Deps): void {
  const { app, redis, relayPool, INDEXER_RELAY_URL_FOR_API, gateRateLimit } = deps;

  app.get('/profile/:pubkey', async (request, reply) => {
    const params = request.params as { pubkey?: string };
    const pubkey = (params.pubkey ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return reply.status(400).send({ error: 'pubkey must be 32-byte hex' });
    }
    if (!(await gateRateLimit(reply, 'profile-read-ip', request.ip, 240, 60))) return reply;

    const cached = await redis.get(`dm:profile-event:${pubkey}`).catch(() => null);
    if (cached) {
      const body = projectCached(cached, pubkey);
      if (body) {
        reply.header('cache-control', 'public, max-age=300');
        return body;
      }
      // Corrupt cache entry — fall through to relay.
    }

    const events = await queryRelaysWithTimeout(
      relayPool,
      [INDEXER_RELAY_URL_FOR_API],
      { kinds: [0], authors: [pubkey], limit: 1 },
      RELAY_TIMEOUT_MS,
    );
    // NIP-01 replaceable-event semantics: when multiple kind:0 events
    // for the same author come back, the newest wins. Most relays
    // already enforce this server-side but a stale one might not, and
    // it's a one-liner to be safe.
    const newest = events.length === 0
      ? null
      : events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    if (!newest) {
      const empty: ProfileResponse = { pubkey, updatedAt: null };
      void redis.set(
        `dm:profile-event:${pubkey}`,
        JSON.stringify({ content: '', created_at: 0 }),
        'EX',
        NEGATIVE_TTL,
      ).catch(() => undefined);
      reply.header('cache-control', 'public, max-age=60');
      return empty;
    }

    if (newest.content.length <= 8 * 1024) {
      void redis.set(
        `dm:profile-event:${pubkey}`,
        JSON.stringify({ content: newest.content, created_at: newest.created_at }),
        'EX',
        POSITIVE_TTL,
      ).catch(() => undefined);
    }
    const body = projectEvent(newest.content, newest.created_at, pubkey);
    reply.header('cache-control', 'public, max-age=300');
    return body;
  });
}

function projectCached(raw: string, pubkey: string): ProfileResponse | null {
  try {
    const parsed = JSON.parse(raw) as { content: string; created_at: number };
    if (!parsed.content) {
      return { pubkey, updatedAt: parsed.created_at || null };
    }
    return projectEvent(parsed.content, parsed.created_at, pubkey);
  } catch {
    return null;
  }
}

function projectEvent(content: string, createdAt: number, pubkey: string): ProfileResponse {
  let parsed: Record<string, unknown> = {};
  try {
    const j = JSON.parse(content);
    if (j && typeof j === 'object') parsed = j as Record<string, unknown>;
  } catch {
    // Empty profile if content isn't JSON.
  }
  const str = (k: string): string | undefined => {
    const v = parsed[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  return {
    pubkey,
    name: str('name'),
    display_name: str('display_name') ?? str('displayName'),
    picture: str('picture'),
    about: str('about'),
    lud16: str('lud16') ?? str('lightning_address'),
    lud06: str('lud06'),
    nip05: str('nip05'),
    website: str('website'),
    updatedAt: createdAt || null,
  };
}
