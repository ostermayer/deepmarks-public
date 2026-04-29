import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { Redis } from 'ioredis';
import type { MeilisearchClient } from '../search.js';

/**
 * URL save-count tracker.
 *
 * Subscribes to kind:39701 events on our relay and maintains a
 * Redis set per canonical URL of the pubkeys who've bookmarked it.
 * Set cardinality = save_count for that URL. Batches updates to
 * Meilisearch so a popular URL doesn't trigger N searches worth of
 * re-indexing.
 *
 * We track per-URL, not per-event, because the save_count is about
 * "how many people bookmarked this URL," not "how many events
 * reference it." One user could edit their bookmark (replacing the
 * event) and we don't want save_count to double.
 */

export interface SaveCountTrackerDeps {
  redis: Redis;
  meili: MeilisearchClient;
  relayUrl: string;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class SaveCountTracker {
  private pool?: SimplePool;
  private sub?: { close: () => void };
  private flushTimer?: NodeJS.Timeout;
  /** event_id → save_count pending flush */
  private dirty: Map<string, number> = new Map();

  constructor(private readonly deps: SaveCountTrackerDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    const checkpoint = parseInt((await this.deps.redis.get('dm:save-tracker:checkpoint')) ?? '0', 10);
    const since = Math.max(checkpoint, Math.floor(Date.now() / 1000) - 86_400);

    this.deps.logger.info({ since, relay: this.deps.relayUrl }, 'save-count tracker starting');

    this.sub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [39701], since },
      {
        onevent: (event) => {
          this.handleBookmark(event).catch((err) =>
            this.deps.logger.error({ err }, 'save-count tracker error'),
          );
        },
      },
    );
  }

  async stop(): Promise<void> {
    this.sub?.close();
    await this.flush();
    this.pool?.close([this.deps.relayUrl]);
  }

  private async handleBookmark(event: NostrEvent): Promise<void> {
    const url = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!url) return;

    const urlHash = sha256hex(canonicalizeUrl(url));
    const setKey = `dm:url-savers:${urlHash}`;

    // SADD is idempotent — re-bookmarking by the same pubkey is a no-op.
    const added = await this.deps.redis.sadd(setKey, event.pubkey);

    if (added === 0) {
      // Already counted — edit of an existing bookmark, not a new save.
      return;
    }

    const newCount = await this.deps.redis.scard(setKey);
    this.dirty.set(event.id, newCount);

    await this.deps.redis.set('dm:save-tracker:checkpoint', event.created_at);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 5_000);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) return;

    const updates = [...this.dirty.entries()].map(([id, save_count]) => ({ id, save_count }));
    this.dirty.clear();

    try {
      await this.deps.meili.upsertBatch(updates as never);
      this.deps.logger.info({ count: updates.length }, 'save counts flushed');
    } catch (err) {
      this.deps.logger.error({ err }, 'save count flush failed — re-queueing');
      for (const { id, save_count } of updates) this.dirty.set(id, save_count);
    }
  }
}

/**
 * Canonicalize a URL for dedup purposes. Doesn't affect display;
 * only used for counting distinct savers.
 *
 *   - Lowercase scheme and host
 *   - Strip default ports (:80, :443)
 *   - Strip trailing slash on path
 *   - Remove fragment (#...)
 *   - Remove utm_* query params (common tracking noise)
 *
 * We don't normalize beyond this because too aggressive normalization
 * conflates distinct pages. E.g. sorting query params would be wrong
 * for pagination (?page=2 vs ?page=3).
 */
function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase().trim();
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  u.hash = '';

  // Strip utm_* query params. Preserve insertion order of the rest.
  const toKeep: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (!k.toLowerCase().startsWith('utm_')) toKeep.push([k, v]);
  }
  u.search = '';
  for (const [k, v] of toKeep) u.searchParams.append(k, v);

  return u.toString();
}

function sha256hex(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}
