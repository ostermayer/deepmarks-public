// /admin/relay-stats?pubkey=<hex> — admin tool for verifying what
// strfry actually has for a given pubkey, vs what the Redis cache
// shows, vs what the user reports seeing in their client.
//
// Born out of a real "my bookmarks are gone" investigation where:
//   - iOS app showed 4203 entries
//   - relay.deepmarks.org had 2 public + 23 private chunks
//   - The Redis cache had only 2 public entries
//   - The user thought the relay was empty
//
// Having one HTTP endpoint that reports the relay state authoritatively
// (kind:39701 count, kind:30003 chunks, kind:0 profile, NIP-65 list)
// + Redis cache state side-by-side makes future "where are my events"
// triage a curl call instead of "let me SSH into Box A and run
// strfry scan".
//
// NIP-98 admin auth required — exposes a per-pubkey view that should
// not be public.

import { queryRelaysWithTimeout } from '../api-helpers.js';
import type { Deps } from '../route-deps.js';

const RELAY_QUERY_TIMEOUT_MS = 5_000;
const SAMPLE_LIMIT = 5;

interface RelayStatsResponse {
  pubkey: string;
  relayUrl: string;
  counts: {
    publicBookmarks: number;       // kind:39701
    privateSetChunks: number;      // kind:30003 (encrypted bookmark set + archive-keys set)
    nip65Lists: number;            // kind:10002 (should be 0 or 1)
    profiles: number;              // kind:0 (should be 0 or 1)
    contacts: number;              // kind:3 (should be 0 or 1)
  };
  cache: {
    publicBookmarks: number;       // from listCachedPublicBookmarks (Redis ZSET)
    profileName: string | null;    // from dm:profile-name:<pubkey>
    lifetimeMember: boolean;       // from lifetime store
    bookmarksBackfilled: boolean;  // from dm:bookmarks:backfilled:<pubkey>
  };
  nip65AdvertisedRelays: string[] | null;
  /** A small recent-events sample so we can spot-check what's actually there. */
  samples: Array<{
    kind: number;
    id: string;
    created_at: number;
    d: string | null;
  }>;
}

export function register(deps: Deps): void {
  const {
    app,
    redis,
    relayPool,
    INDEXER_RELAY_URL_FOR_API,
    requireAdmin,
    lifetimeStore,
  } = deps;

  app.get<{ Querystring: { pubkey?: string } }>(
    '/admin/relay-stats',
    async (request, reply) => {
      const auth = await requireAdmin({
        headers: request.headers,
        url: '/admin/relay-stats',
        method: 'GET',
      });
      if (!auth.ok) {
        return reply.status(auth.status ?? 401).send({ error: auth.reason });
      }

      const pubkey = (request.query?.pubkey ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pubkey)) {
        return reply.status(400).send({ error: 'pubkey must be 32-byte hex' });
      }

      // Run the four relay queries in parallel. Each has its own
      // timeout; if one relay is misbehaving it won't drag the whole
      // response above ~5s.
      const filters = [
        { name: 'publicBookmarks', filter: { kinds: [39701], authors: [pubkey], limit: 5000 } },
        { name: 'privateSetChunks', filter: { kinds: [30003], authors: [pubkey], limit: 500 } },
        { name: 'nip65Lists', filter: { kinds: [10002], authors: [pubkey], limit: 5 } },
        { name: 'profiles', filter: { kinds: [0], authors: [pubkey], limit: 5 } },
        { name: 'contacts', filter: { kinds: [3], authors: [pubkey], limit: 5 } },
      ] as const;

      const queries = await Promise.all(
        filters.map(({ filter }) =>
          queryRelaysWithTimeout(
            relayPool,
            [INDEXER_RELAY_URL_FOR_API],
            filter,
            RELAY_QUERY_TIMEOUT_MS,
          ).catch(() => [])
        ),
      );

      const counts = {
        publicBookmarks: queries[0]!.length,
        privateSetChunks: queries[1]!.length,
        nip65Lists: queries[2]!.length,
        profiles: queries[3]!.length,
        contacts: queries[4]!.length,
      };

      // NIP-65 read: latest by created_at wins.
      const nip65Event = queries[2]!.length === 0
        ? null
        : queries[2]!.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      const nip65AdvertisedRelays = nip65Event
        ? nip65Event.tags.filter((t) => t[0] === 'r' && typeof t[1] === 'string').map((t) => t[1]!)
        : null;

      // Redis cache side-by-side.
      const [authorCacheCount, profileName, isLifetime, backfilled] = await Promise.all([
        redis.zcard(`dm:public-bookmarks:author:${pubkey}`).catch(() => 0),
        redis.get(`dm:profile-name:${pubkey}`).catch(() => null),
        lifetimeStore.isPaid(pubkey).catch(() => false),
        redis.get(`dm:bookmarks:backfilled:${pubkey}`).catch(() => null).then((v) => v === '1'),
      ]);

      // Sample: 1-2 recent events of each kind, so an operator can
      // eyeball d-tags / created_at without scanning strfry by hand.
      const samples: RelayStatsResponse['samples'] = [];
      for (let i = 0; i < filters.length; i++) {
        const list = queries[i]!;
        const recent = list
          .slice()
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 2);
        for (const ev of recent) {
          samples.push({
            kind: ev.kind,
            id: ev.id,
            created_at: ev.created_at,
            d: ev.tags.find((t) => t[0] === 'd')?.[1] ?? null,
          });
        }
        if (samples.length >= SAMPLE_LIMIT) break;
      }

      const body: RelayStatsResponse = {
        pubkey,
        relayUrl: INDEXER_RELAY_URL_FOR_API,
        counts,
        cache: {
          publicBookmarks: authorCacheCount,
          profileName: profileName ?? null,
          lifetimeMember: isLifetime,
          bookmarksBackfilled: backfilled,
        },
        nip65AdvertisedRelays,
        samples,
      };
      reply.header('cache-control', 'no-store');
      return body;
    },
  );
}
