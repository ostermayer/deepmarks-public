// Live subscription for NIP-57 zap receipts (kind:9735).
//
// We expose the flat list of receipt records (id + eventId + ts) instead
// of pre-aggregated counts so consumers can filter by time window before
// tallying (used by the /app/popular "all/year/month/week/24h" selector).
// A full-list Svelte store over a bounded volume (strfry only accepts
// {9735, 39701, 1985, 24133}) is fine; the ranking function tallies on
// demand.

import { readable, type Readable } from 'svelte/store';
import { NDKSubscriptionCacheUsage, type NDKEvent, type NDKKind, type NDKSubscription } from '@nostr-dev-kit/ndk';
import { ensureRelayUrlsConnected, getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { parseZapAmountMsat } from './popularity.js';

export interface ZapReceiptRecord {
  /** Receipt event id — used for cross-relay dedup. */
  id: string;
  /** The target bookmark event id (first `e` tag on the receipt), or
   *  null if the receipt had no e-tag (profile zap, etc.). */
  eventId: string | null;
  /** Receipt created_at in unix seconds — drives the time-window filter. */
  ts: number;
  /** Amount in millisats — drives the firehose quality floor. Zero
   *  when the receipt carries no parseable amount (malformed / missing
   *  description + bolt11). */
  amountMsat: number;
}

const HEX_EVENT_ID_RE = /^[0-9a-f]{64}$/i;
const ZAP_FILTER_CHUNK_SIZE = 120;

/** Public relays that commonly carry NIP-57 receipts from mainstream Nostr
 * clients. Targeted #e subscriptions keep the query bounded while letting
 * feed rows use network-visible zap totals instead of only receipts mirrored
 * by relay.deepmarks.org. */
export const GLOBAL_ZAP_RELAY_URLS = [
  'wss://relay.deepmarks.org',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
] as const;

function receiptFromEvent(event: NDKEvent): ZapReceiptRecord {
  const eTag = event.tags.find((t) => t[0] === 'e');
  return {
    id: event.id,
    eventId: eTag?.[1] ?? null,
    ts: event.created_at ?? 0,
    amountMsat: parseZapAmountMsat(event.tags),
  };
}

function uniqueEventIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const normalized = id.toLowerCase();
    if (!HEX_EVENT_ID_RE.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function idChunks(ids: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export function createZapReceiptFeed(): Readable<ZapReceiptRecord[]> {
  return readable<ZapReceiptRecord[]>([], (set) => {
    const ndk = getNdk();
    const list: ZapReceiptRecord[] = [];
    const seen = new Set<string>();

    let sub: NDKSubscription | null = null;
    try {
      sub = ndk.subscribe({ kinds: [KIND.zapReceipt as unknown as NDKKind] }, {
        closeOnEose: false,
        cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
      });
      sub.on('event', (event: NDKEvent) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        list.push(receiptFromEvent(event));
        // Emit a fresh array so `derived` stores pick up the change —
        // Svelte's equality check wouldn't trip on in-place mutation.
        set(list.slice());
      });
    } catch (err) {
      // NDK pool not connected yet — caller's next subscription recreates us.
      // eslint-disable-next-line no-console
      console.warn('zap-receipt feed subscription failed:', err);
    }

    return () => {
      sub?.stop();
    };
  });
}

export interface TargetedZapReceiptOptions {
  targetEventIds: readonly string[];
  relayUrls?: readonly string[];
  limit?: number;
}

export function createTargetedZapReceiptFeed(
  opts: TargetedZapReceiptOptions,
): Readable<ZapReceiptRecord[]> {
  const targetEventIds = uniqueEventIds(opts.targetEventIds);
  const relayUrls = opts.relayUrls ?? GLOBAL_ZAP_RELAY_URLS;
  const limit = opts.limit ?? Math.min(10_000, Math.max(500, targetEventIds.length * 25));

  return readable<ZapReceiptRecord[]>([], (set) => {
    if (targetEventIds.length === 0) {
      set([]);
      return () => {};
    }

    const ndk = getNdk();
    ensureRelayUrlsConnected(relayUrls);
    const list: ZapReceiptRecord[] = [];
    const seen = new Set<string>();
    const subs: NDKSubscription[] = [];

    function absorb(event: NDKEvent): void {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      list.push(receiptFromEvent(event));
      set(list.slice());
    }

    try {
      for (const chunk of idChunks(targetEventIds, ZAP_FILTER_CHUNK_SIZE)) {
        const filter = {
          kinds: [KIND.zapReceipt as unknown as NDKKind],
          '#e': chunk,
          limit,
        };
        const sub = ndk.subscribe(filter, {
          closeOnEose: false,
          cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
        });
        sub.on('event', absorb);
        subs.push(sub);
      }
    } catch (err) {
      console.warn('targeted zap-receipt feed subscription failed:', err);
    }

    return () => {
      for (const sub of subs) sub.stop();
    };
  });
}
