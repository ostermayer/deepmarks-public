import { SimplePool, verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';

/**
 * Profile name resolver.
 *
 * Subscribes to kind:0 (profile metadata) events and maintains two
 * Redis indexes so search can resolve pubkey ↔ display name:
 *
 *   dm:profile-name:<pubkey>        → display name (for search result rendering)
 *   dm:profile-pubkey:<name-lower>  → pubkey (for @handle queries)
 *
 * Tracks profiles that land on our relay. The relay is already scoped
 * to Deepmarks users plus followed curators mirrored by the outbox
 * ingester, so storing every kind:0 we see is still bounded while
 * letting friend lists paint names and avatars immediately.
 *
 * Profile names are not unique. If two users pick "alice" as their
 * display name, the reverse index will only hold the most recent
 * one. This is fine for a fuzzy search hint; precise identity is
 * always the pubkey.
 */

const PROFILE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const BOOKMARK_ACTIVITY_LOOKBACK_SECONDS = 24 * 60 * 60;
const PROFILE_FETCH_CONCURRENCY = 3;
const MAX_QUEUED_PROFILE_FETCHES = 500;

export interface ProfileResolverDeps {
  redis: Redis;
  relayUrl: string;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class ProfileResolver {
  private pool?: SimplePool;
  private profilesSub?: { close: () => void };
  private bookmarksSub?: { close: () => void };
  /** pubkeys we've seen bookmark activity from → should resolve their profile */
  private tracked: Set<string> = new Set();
  private queuedProfileFetches: string[] = [];
  private queuedProfileFetchSet: Set<string> = new Set();
  private activeProfileFetches = 0;

  constructor(private readonly deps: ProfileResolverDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    this.deps.logger.info({ relay: this.deps.relayUrl }, 'profile resolver starting');
    const bookmarkSince = Math.floor(Date.now() / 1000) - BOOKMARK_ACTIVITY_LOOKBACK_SECONDS;

    // Track recently active pubkeys. Avoid replaying the relay's full
    // bookmark history on every boot: each new author triggers a profile
    // fetch, and an unbounded replay can exceed strfry's subscription cap.
    this.bookmarksSub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [39701], since: bookmarkSince, limit: 1000 },
      {
        onevent: (event) => {
          if (this.tracked.has(event.pubkey)) return;
          this.tracked.add(event.pubkey);
          this.enqueueProfileFetch(event.pubkey);
        },
      },
    );

    // Continuous subscription to profile updates. Our relay is not a
    // general-purpose firehose; it contains Deepmarks users and followed
    // curators, so cache every kind:0 that reaches it.
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // 7 days
    this.profilesSub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [0], since },
      {
        onevent: (event) => {
          this.tracked.add(event.pubkey);
          this.storeProfile(event).catch((err) =>
            this.deps.logger.error({ err }, 'profile storage error'),
          );
        },
      },
    );
  }

  async stop(): Promise<void> {
    this.bookmarksSub?.close();
    this.profilesSub?.close();
    this.queuedProfileFetches = [];
    this.queuedProfileFetchSet.clear();
    this.pool?.close([this.deps.relayUrl]);
  }

  private enqueueProfileFetch(pubkey: string): void {
    const normalized = pubkey.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) return;
    if (this.queuedProfileFetchSet.has(normalized)) return;
    if (this.queuedProfileFetches.length >= MAX_QUEUED_PROFILE_FETCHES) return;
    this.queuedProfileFetchSet.add(normalized);
    this.queuedProfileFetches.push(normalized);
    this.drainProfileFetchQueue();
  }

  private drainProfileFetchQueue(): void {
    while (
      this.pool &&
      this.activeProfileFetches < PROFILE_FETCH_CONCURRENCY &&
      this.queuedProfileFetches.length > 0
    ) {
      const pubkey = this.queuedProfileFetches.shift()!;
      this.activeProfileFetches += 1;
      this.fetchProfile(pubkey)
        .catch((err) => this.deps.logger.error({ err, pubkey }, 'profile fetch error'))
        .finally(() => {
          this.activeProfileFetches -= 1;
          this.queuedProfileFetchSet.delete(pubkey);
          this.drainProfileFetchQueue();
        });
    }
  }

  private async fetchProfile(pubkey: string): Promise<void> {
    if (!this.pool) return;
    // One-shot query for the latest kind:0 from this pubkey.
    const events = await this.pool.querySync(
      [this.deps.relayUrl],
      { kinds: [0], authors: [pubkey], limit: 1 },
    );
    if (events.length > 0) {
      await this.storeProfile(events[0]!);
    }
  }

  private async storeProfile(event: NostrEvent): Promise<void> {
    await cacheProfileEvent(this.deps.redis, event);
  }
}

export async function cacheProfileEvent(redis: Redis, event: NostrEvent): Promise<void> {
  // Re-verify at the sink. The follows-ingester fetches kind:0 from
  // curators' EXTERNAL NIP-65 relays over a raw WebSocket that only
  // shape-checks the event (no signature check), then caches it keyed by
  // the event's own `pubkey`. Without this, a hostile relay could return a
  // forged kind:0 for an arbitrary victim pubkey with an attacker-chosen
  // name/picture/nip05/lud16 — poisoning /profile/:pubkey and redirecting
  // manual zaps. Events arriving from our own strfry are already valid, so
  // this is a no-op cost on that path.
  if (event.kind !== 0) return;
  try {
    if (!verifyEvent(event)) return;
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const metadata = parsed as { name?: unknown; display_name?: unknown; displayName?: unknown };
  const pubkey = event.pubkey.toLowerCase();

  // Cache the full event so /profile/:pubkey can serve the parsed
  // profile (name + picture + lud16 + nip05) without hitting the
  // relay. Kept under a separate key so existing name-only lookups
  // stay cheap.
  if (event.content.length <= 8 * 1024) {
    await redis
      .set(
        `dm:profile-event:${pubkey}`,
        JSON.stringify({ content: event.content, created_at: event.created_at }),
        'EX',
        PROFILE_TTL_SECONDS,
      )
      .catch(() => undefined);
  }

  const name = firstString(metadata.name, metadata.display_name, metadata.displayName).trim();
  if (!name) return;

  // Length sanity — a display name longer than 64 chars is probably an
  // attempt to spam our index.
  if (name.length > 64) return;

  const pipeline = redis.multi();

  // Clean up any previous reverse mapping for this pubkey. We don't
  // know their old name without a lookup, so keep a pointer.
  const oldName = await redis.get(`dm:profile-name:${pubkey}`);
  if (oldName && oldName.toLowerCase() !== name.toLowerCase()) {
    // Only unmap if the reverse still points at us. Prevents
    // name-collision stomping someone else's pointer.
    const oldPointer = await redis.get(
      `dm:profile-pubkey:${oldName.toLowerCase()}`,
    );
    if (oldPointer === pubkey) {
      pipeline.del(`dm:profile-pubkey:${oldName.toLowerCase()}`);
    }
  }

  pipeline.set(`dm:profile-name:${pubkey}`, name, 'EX', PROFILE_TTL_SECONDS);
  pipeline.set(
    `dm:profile-pubkey:${name.toLowerCase()}`,
    pubkey,
    'EX',
    PROFILE_TTL_SECONDS,
  );
  await pipeline.exec();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}
