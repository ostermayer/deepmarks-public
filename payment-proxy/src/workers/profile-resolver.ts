import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
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
 * Only tracks profiles for pubkeys that have at least one bookmark
 * on our relay — we don't need to index the whole Nostr network.
 *
 * Profile names are not unique. If two users pick "alice" as their
 * display name, the reverse index will only hold the most recent
 * one. This is fine for a fuzzy search hint; precise identity is
 * always the pubkey.
 */

const PROFILE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

  constructor(private readonly deps: ProfileResolverDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    this.deps.logger.info({ relay: this.deps.relayUrl }, 'profile resolver starting');

    // Track which pubkeys we care about. Anyone who's ever published
    // a kind:39701 on our relay goes in the tracked set.
    this.bookmarksSub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [39701] },
      {
        onevent: (event) => {
          if (this.tracked.has(event.pubkey)) return;
          this.tracked.add(event.pubkey);
          // Opportunistically fetch their profile. This is a one-shot
          // request, separate from the continuous profile sub below.
          this.fetchProfile(event.pubkey).catch(() => {});
        },
      },
    );

    // Continuous subscription to profile updates for tracked pubkeys.
    // We'd prefer a per-pubkey subscription list but most relays
    // handle wildcard kind:0 filters reasonably — we filter client-side.
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // 7 days
    this.profilesSub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [0], since },
      {
        onevent: (event) => {
          if (!this.tracked.has(event.pubkey)) return;
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
    this.pool?.close([this.deps.relayUrl]);
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
    let parsed: { name?: string; display_name?: string };
    try {
      parsed = JSON.parse(event.content);
    } catch {
      return;
    }

    const name = (parsed.display_name || parsed.name || '').trim();
    if (!name) return;

    // Length sanity — a display name longer than 64 chars is
    // probably an attempt to spam our index.
    if (name.length > 64) return;

    const pipeline = this.deps.redis.multi();

    // Clean up any previous reverse mapping for this pubkey. We
    // don't know their old name without a lookup, so keep a pointer.
    const oldName = await this.deps.redis.get(`dm:profile-name:${event.pubkey}`);
    if (oldName && oldName.toLowerCase() !== name.toLowerCase()) {
      // Only unmap if the reverse still points at us. Prevents
      // name-collision stomping someone else's pointer.
      const oldPointer = await this.deps.redis.get(
        `dm:profile-pubkey:${oldName.toLowerCase()}`,
      );
      if (oldPointer === event.pubkey) {
        pipeline.del(`dm:profile-pubkey:${oldName.toLowerCase()}`);
      }
    }

    pipeline.set(`dm:profile-name:${event.pubkey}`, name, 'EX', PROFILE_TTL_SECONDS);
    pipeline.set(
      `dm:profile-pubkey:${name.toLowerCase()}`,
      event.pubkey,
      'EX',
      PROFILE_TTL_SECONDS,
    );
    await pipeline.exec();
  }
}
