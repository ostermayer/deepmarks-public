// Pure helpers for the /api/v1 surface. Kept here instead of inside
// index.ts so tests can import them without booting Fastify.

import { z } from 'zod';
import { SimplePool, type Event as NostrEvent } from 'nostr-tools';

/**
 * Zod shape for a signed Nostr event. Strict on the fields we care about;
 * tolerant of unknown extras so we don't break on forward-compat additions.
 */
export const SignedEventSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: z.number().int().nonnegative(),
  kind: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

export interface BookmarkJson {
  id: string;
  pubkey: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  archivedForever: boolean;
  blossomHash?: string;
  waybackUrl?: string;
  publishedAt?: number;
  savedAt: number;
}

/** Extract the standard NIP-B0 fields from a kind:39701 event. */
export function bookmarkEventToJson(event: NostrEvent): BookmarkJson {
  const get = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const url = get('d') ?? '';
  return {
    id: event.id,
    pubkey: event.pubkey,
    url,
    title: get('title') ?? url,
    description: get('description') ?? '',
    tags: event.tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean),
    archivedForever: get('archive-tier') === 'forever',
    blossomHash: get('blossom'),
    waybackUrl: get('wayback'),
    publishedAt: get('published_at') ? Number(get('published_at')) : undefined,
    savedAt: event.created_at,
  };
}

/** Collect matching events from a set of relays within `timeoutMs`. */
export async function queryRelaysWithTimeout(
  pool: SimplePool,
  relays: string[],
  filter: Record<string, unknown>,
  timeoutMs: number,
): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  return new Promise((resolve) => {
    const sub = pool.subscribeMany(relays, filter as never, {
      onevent: (e) => out.push(e),
      oneose: () => { sub.close(); resolve(out); },
    });
    setTimeout(() => { sub.close(); resolve(out); }, timeoutMs);
  });
}

/** Publish an event to a relay list; returns ok/failed split for the response body. */
export async function publishToRelays(
  pool: SimplePool,
  relays: string[],
  event: NostrEvent,
  timeoutMs: number,
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  const publishes = pool.publish(relays, event);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([
    Promise.allSettled(publishes).then((results) => {
      results.forEach((r, i) => {
        const url = relays[i] ?? '';
        if (r.status === 'fulfilled') ok.push(url);
        else failed.push(url);
      });
    }),
    timeout,
  ]);
  return { ok, failed };
}
