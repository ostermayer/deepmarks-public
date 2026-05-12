import { SimplePool, type Event as NostrEvent } from 'nostr-tools';
import type { Redis } from 'ioredis';
import type { MeilisearchClient } from '../search.js';

/**
 * Zap receipt listener.
 *
 * Subscribes to kind:9735 zap receipts on our relay, sums sats by
 * target event, and keeps Meilisearch's zap_total field fresh for
 * public search ranking.
 *
 * Why subscribe to our relay (not all relays)? Public search only
 * indexes events on our relay (see Flow N). A bookmark not on our
 * relay isn't searchable here anyway, so its zaps don't need to
 * update our index. Users who want cross-relay zap aggregation can
 * build their own index.
 */

export interface ZapReceiptListenerDeps {
  redis: Redis;
  meili: MeilisearchClient;
  relayUrl: string;
  /** Pubkeys we trust to sign authentic kind:9735 receipts. Without
   *  this filter, anyone can publish a kind:9735 with any `amount` tag
   *  and inflate a bookmark's zap_total — gaming public search
   *  ranking with no payment. Bootstrap value should include at least
   *  the brand LNURL signer. Empty set ⇒ trust nothing (safer
   *  default for a misconfigured deploy than trust-everyone). */
  trustedReceiptIssuers: ReadonlySet<string>;
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class ZapReceiptListener {
  private pool?: SimplePool;
  private sub?: { close: () => void };
  private flushTimer?: NodeJS.Timeout;
  private dirty: Set<string> = new Set();

  constructor(private readonly deps: ZapReceiptListenerDeps) {}

  async start(): Promise<void> {
    this.pool = new SimplePool();
    // Resume from last seen zap, capped at "now minus 1 day" so a
    // long outage doesn't cause a giant catch-up storm.
    const checkpoint = parseInt((await this.deps.redis.get('dm:zap-listener:checkpoint')) ?? '0', 10);
    const since = Math.max(checkpoint, Math.floor(Date.now() / 1000) - 86_400);

    this.deps.logger.info({ since, relay: this.deps.relayUrl }, 'zap listener starting');

    this.sub = this.pool.subscribeMany(
      [this.deps.relayUrl],
      { kinds: [9735], since },
      {
        onevent: (event) => {
          this.handleReceipt(event).catch((err) =>
            this.deps.logger.error({ err }, 'zap receipt handler error'),
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

  private async handleReceipt(event: NostrEvent): Promise<void> {
    // Drop receipts from issuers we don't trust. NIP-57 says the relay
    // should accept zap receipts from any LNURL provider; we choose
    // not to count them in OUR ranking unless we know the provider.
    // Otherwise anyone can self-zap a bookmark to the top of search.
    if (!this.deps.trustedReceiptIssuers.has(event.pubkey)) return;

    const targetEventId = event.tags.find((t) => t[0] === 'e')?.[1];
    if (!targetEventId) return;

    const amountMsat = extractAmountMsat(event);
    if (amountMsat === null || amountMsat <= 0) return;
    const sats = Math.floor(amountMsat / 1000);
    if (sats === 0) return;

    // Aggregate per target event. Use HINCRBY so concurrent receipts
    // are additive-safe without read-modify-write races.
    await this.deps.redis.hincrby('dm:zap-totals', targetEventId, sats);
    this.dirty.add(targetEventId);

    // Update checkpoint so we resume past this event on restart.
    await this.deps.redis.set('dm:zap-listener:checkpoint', event.created_at);

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    // Batch Meilisearch updates every 5s so we don't hammer it on
    // viral bookmarks that might get hundreds of zaps in quick
    // succession.
    this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 5_000);
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) return;

    const eventIds = [...this.dirty];
    this.dirty.clear();

    try {
      const totals = await this.deps.redis.hmget('dm:zap-totals', ...eventIds);
      const updates = eventIds.map((id, i) => ({
        id,
        zap_total: parseInt(totals[i] ?? '0', 10),
      }));
      await this.deps.meili.upsertBatch(updates as never);
      this.deps.logger.info({ count: updates.length }, 'zap totals flushed');
    } catch (err) {
      this.deps.logger.error({ err }, 'zap total flush failed — re-queueing');
      // Restore dirty set so we retry on next flush.
      for (const id of eventIds) this.dirty.add(id);
    }
  }
}

/**
 * Extract the zap amount in millisats from a kind:9735 receipt.
 *
 * The amount is authoritatively in the embedded BOLT-11 invoice
 * (bolt11 tag), but NIP-57 also allows it in the zap request's
 * `amount` tag. Check the request first since it's cheaper to parse.
 */
function extractAmountMsat(receipt: NostrEvent): number | null {
  // Try the embedded zap request (description tag).
  const descTag = receipt.tags.find((t) => t[0] === 'description')?.[1];
  if (descTag) {
    try {
      const request = JSON.parse(descTag) as { tags?: string[][] };
      const amountTag = request.tags?.find((t) => t[0] === 'amount')?.[1];
      if (amountTag) {
        const parsed = parseInt(amountTag, 10);
        if (!isNaN(parsed)) return parsed;
      }
    } catch {
      // fall through to bolt11
    }
  }

  // Fall back to decoding the bolt11 invoice amount.
  const bolt11 = receipt.tags.find((t) => t[0] === 'bolt11')?.[1];
  if (bolt11) {
    return decodeBolt11Amount(bolt11);
  }

  return null;
}

/**
 * Minimal BOLT-11 amount decoder. Extracts the amount prefix without
 * validating the whole invoice (receipts should have been validated
 * by the relay's NIP-57 enforcement; we just need the number).
 *
 * Format: ln{network}{amount}{multiplier}... where amount is digits
 * and multiplier is one of m, u, n, p or absent.
 *
 *   m = milli (1e-3 BTC)
 *   u = micro (1e-6 BTC)
 *   n = nano  (1e-9 BTC)
 *   p = pico  (1e-12 BTC)
 */
export function decodeBolt11Amount(invoice: string): number | null {
  const match = /^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/.exec(invoice.toLowerCase());
  if (!match) return null;
  const amount = parseInt(match[1]!, 10);
  const mult = match[2];
  // Convert to millisats: 1 BTC = 1e8 sats = 1e11 msats.
  switch (mult) {
    case 'm': return amount * 1e8;        // milli-BTC → msats
    case 'u': return amount * 1e5;        // micro-BTC → msats
    case 'n': return amount * 1e2;        // nano-BTC → msats
    case 'p': return amount / 10;         // pico-BTC → msats (1p = 0.1 msat, rounded)
    case '': return amount * 1e11;        // BTC → msats
    default:  return null;
  }
}
