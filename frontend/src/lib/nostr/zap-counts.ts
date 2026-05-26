// Live subscription for NIP-57 zap receipts (kind:9735).
//
// We expose the flat list of receipt records (id + eventId + ts) instead
// of pre-aggregated counts so consumers can filter by time window before
// tallying (used by the /app/popular "all/year/month/week/24h" selector).
// A full-list Svelte store over a bounded volume (strfry only accepts
// {9735, 39701, 1985, 24133}) is fine; the ranking function tallies on
// demand.

import { readable, type Readable } from 'svelte/store';
import type { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
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

export function createZapReceiptFeed(): Readable<ZapReceiptRecord[]> {
  return readable<ZapReceiptRecord[]>([], (set) => {
    const ndk = getNdk();
    const list: ZapReceiptRecord[] = [];
    const seen = new Set<string>();

    let sub: NDKSubscription | null = null;
    try {
      sub = ndk.subscribe({ kinds: [9735] }, { closeOnEose: false });
      sub.on('event', (event: NDKEvent) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        const eTag = event.tags.find((t) => t[0] === 'e');
        list.push({
          id: event.id,
          eventId: eTag?.[1] ?? null,
          ts: event.created_at ?? 0,
          amountMsat: parseZapAmountMsat(event.tags),
        });
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
