import { z } from 'zod';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  allowBookmarkedNoteTargets,
  fetchBookmarkedKind1Targets,
  normalizeEventIds,
  normalizeRelayList,
  SOCIAL_BOOKMARK_DISCOVERY_RELAYS,
} from '../bookmarked-note-targets.js';
import { publishToRelays } from '../api-helpers.js';
import type { Deps } from '../route-deps.js';

const MAX_EVENT_IDS_PER_REQUEST = 1_000;
const MAX_RELAY_HINTS_PER_REQUEST = 30;
const MAX_QUERY_RELAYS = 16;
const QUERY_TIMEOUT_MS = 5_000;
const LOCAL_PUBLISH_TIMEOUT_MS = 3_000;

const PrefetchRequestSchema = z.object({
  eventIds: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).min(1).max(MAX_EVENT_IDS_PER_REQUEST),
  relays: z.array(z.string().min(1).max(300)).max(MAX_RELAY_HINTS_PER_REQUEST).optional(),
});

export interface SocialBookmarkPrefetchResponse {
  requested: number;
  found: number;
  imported: number;
  failed: number;
}

export function register(deps: Deps): void {
  const {
    app,
    redis,
    relayPool,
    requireNip98,
    rateLimit,
    PUBLIC_BASE_URL,
    INDEXER_RELAY_URL_FOR_API,
  } = deps;

  app.post('/nostr/social-bookmarks/prefetch', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/nostr/social-bookmarks/prefetch`,
      'POST',
      { bindBody: true },
    );
    if (!auth) return;

    const gate = await rateLimit('social-bookmark-prefetch', auth.pubkey, 20, 10 * 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }

    const parsed = PrefetchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid payload', detail: parsed.error.message });
    }

    const ids = normalizeEventIds(parsed.data.eventIds);
    if (ids.length === 0) {
      return {
        requested: 0,
        found: 0,
        imported: 0,
        failed: 0,
      } satisfies SocialBookmarkPrefetchResponse;
    }

    // Mark the exact targets before publishing so strfry's writePolicy
    // accepts those signed kind:1 events even when the target author is
    // not a registered Deepmarks user.
    await allowBookmarkedNoteTargets(redis, ids);

    const relays = normalizeRelayList([
      ...(parsed.data.relays ?? []),
      INDEXER_RELAY_URL_FOR_API,
      ...SOCIAL_BOOKMARK_DISCOVERY_RELAYS,
    ]).slice(0, MAX_QUERY_RELAYS);

    const events = await fetchBookmarkedKind1Targets(relayPool, relays, ids, {
      timeoutMs: QUERY_TIMEOUT_MS,
      maxTargets: MAX_EVENT_IDS_PER_REQUEST,
      maxRelays: MAX_QUERY_RELAYS,
    });

    let imported = 0;
    let failed = 0;
    for (const event of events) {
      const ok = await publishTargetToLocalRelay(event, deps).catch(() => false);
      if (ok) imported += 1;
      else failed += 1;
    }

    reply.header('cache-control', 'no-store');
    return {
      requested: ids.length,
      found: events.length,
      imported,
      failed,
    } satisfies SocialBookmarkPrefetchResponse;
  });
}

async function publishTargetToLocalRelay(event: NostrEvent, deps: Deps): Promise<boolean> {
  const { ok } = await publishToRelays(
    deps.relayPool,
    [deps.INDEXER_RELAY_URL_FOR_API],
    event,
    LOCAL_PUBLISH_TIMEOUT_MS,
  );
  return ok.length > 0;
}
