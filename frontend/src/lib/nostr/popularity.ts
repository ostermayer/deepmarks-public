// Client-side popularity ranking.
//
// Score = distinct curator saves + (zap receipts × 2). A zap is the
// stronger signal than a plain save — it reflects a deliberate Lightning
// payment on top of the save itself — so it counts double in the ranking.
// When zap data isn't available (caller didn't pass it, or the zap feed
// hasn't resolved yet), the score degrades gracefully to save count only.
//
// Pure: input a list of bookmarks + optional zap-count map, get back the
// same bookmarks sorted by score desc, with score / saveCount / zapCount
// attached. Server-side ranking (Meilisearch via SaveCountTracker) will
// eventually replace this for very large catalogs; for landing-page and
// anonymous browsing it lives here with no backend round-trip.

import type { ParsedBookmark } from './bookmarks.js';

export interface RankedBookmark extends ParsedBookmark {
  /** Distinct curators who've saved this URL across the input list. */
  saveCount: number;
  /** Zap receipts (kind:9735) that landed against any event id for this URL. */
  zapCount: number;
  /** Total zapped sats across all receipts for this URL. */
  totalZapSats: number;
  /** `saveCount + zapCount × 2` — what the list is sorted by. */
  score: number;
}

export interface ZapAggregate {
  count: number;
  totalMsat: number;
}

export interface PopularityFloorOpts {
  /** Curator pubkey that bypasses the firehose zap threshold — typically
   *  the Deepmarks brand. Entries authored by this pubkey only need to
   *  meet the baseline (minScore). */
  brandPubkey?: string;
  /** Baseline score every entry must meet (default 2: one save + one zap
   *  weighted at 2, or two saves). */
  minScore?: number;
  /** Sats threshold that firehose (non-brand) entries must exceed
   *  (default 500 → total zaps > 500 sats). */
  firehoseMinZapSats?: number;
}

/** Multiplier applied to zap count in the score. Exported for tests and
 *  for any future UI that wants to render the weighting transparently. */
export const ZAP_WEIGHT = 2;

/**
 * Group by URL, pick the freshest representative per URL, attach save +
 * zap counts, score by `saves + zaps × 2`, and sort.
 *
 * Bookmarks are parametric-replaceable by URL; different versions of the
 * same URL can exist under different event ids. A zap to an older version
 * still counts toward that URL's popularity — we aggregate zap receipts
 * across every event id we've seen for the URL.
 *
 * The "freshest representative" rule is: latest `savedAt` wins, ties broken
 * by lexicographic event id (matches NIP-01 / our feed dedup logic).
 */
export function rankByPopularity(
  bookmarks: ParsedBookmark[],
  /** Map from bookmark event id → zap aggregate (count + totalMsat).
   *  For backwards compatibility also accepts a `count`-only map as
   *  `Map<string, number>`; the amount falls through as 0 in that case.
   *  Absent or empty = score reduces to save count. */
  zapDataByEventId?: Map<string, ZapAggregate> | Map<string, number>,
): RankedBookmark[] {
  interface Bucket {
    rep: ParsedBookmark;
    curators: Set<string>;
    /** All event ids we've seen for this URL (across versions + curators)
     *  — the keys we sum zap counts over. */
    eventIds: Set<string>;
  }
  const byUrl = new Map<string, Bucket>();
  for (const b of bookmarks) {
    const slot = byUrl.get(b.url);
    if (!slot) {
      byUrl.set(b.url, {
        rep: b,
        curators: new Set([b.curator]),
        eventIds: new Set([b.eventId]),
      });
      continue;
    }
    slot.curators.add(b.curator);
    slot.eventIds.add(b.eventId);
    if (
      b.savedAt > slot.rep.savedAt ||
      (b.savedAt === slot.rep.savedAt && b.eventId > slot.rep.eventId)
    ) {
      slot.rep = b;
    }
  }

  const ranked: RankedBookmark[] = [];
  for (const { rep, curators, eventIds } of byUrl.values()) {
    const saveCount = curators.size;
    let zapCount = 0;
    let totalMsat = 0;
    if (zapDataByEventId) {
      for (const id of eventIds) {
        const entry = zapDataByEventId.get(id);
        if (entry === undefined) continue;
        if (typeof entry === 'number') {
          zapCount += entry;
        } else {
          zapCount += entry.count;
          totalMsat += entry.totalMsat;
        }
      }
    }
    ranked.push({
      ...rep,
      saveCount,
      zapCount,
      totalZapSats: Math.floor(totalMsat / 1000),
      score: saveCount + zapCount * ZAP_WEIGHT,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // When scores tie on the bootstrap path (all 1-save, 0-zap seeded
    // catalog), a savedAt tiebreaker would make "popular" look identical
    // to "recent". A deterministic event-id hash gives a stable, distinct
    // order that still converges on real popularity signals as soon as
    // they exist.
    const hashA = hashEventId(a.eventId);
    const hashB = hashEventId(b.eventId);
    if (hashA !== hashB) return hashA - hashB;
    return b.savedAt - a.savedAt;
  });
  return ranked;
}

/**
 * Quality floor for the popular list. Brand-curated (seeded Pinboard)
 * content gets an **unconditional editorial pass** — it bypasses both
 * the baseline and the firehose zap check. Everything else must clear:
 *   1. Baseline — saveCount + zapCount × 2 must reach minScore (default 2).
 *      Removes single-save single-curator noise.
 *   2. Firehose — entries NOT authored by the brand pubkey must additionally
 *      clear totalZapSats > firehoseMinZapSats (default 500). Real sats on
 *      the table is how open-Nostr content earns a popular slot.
 *
 * Pure filter; does not mutate input. Order-preserving.
 */
export function applyPopularityFloor(
  ranked: RankedBookmark[],
  opts: PopularityFloorOpts = {},
): RankedBookmark[] {
  const minScore = opts.minScore ?? 2;
  const firehoseMinZapSats = opts.firehoseMinZapSats ?? 500;
  const brandPubkey = opts.brandPubkey;
  return ranked.filter((b) => {
    // Brand exemption takes priority over every other check — seeded
    // content is always visible by editorial choice.
    if (brandPubkey && b.curator === brandPubkey) return true;
    if (b.score < minScore) return false;
    return b.totalZapSats > firehoseMinZapSats;
  });
}

/** djb2 — good-enough spread for a short hex id, no crypto needed. */
function hashEventId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/**
 * Aggregate a list of kind:9735 zap receipts into a `eventId → count` map.
 * Pure — exported so tests + the live zap-receipt feed share the same shape.
 *
 * Dedupes by receipt event id so the same receipt arriving on multiple
 * relays doesn't inflate the count. Reads the `e` tag (NIP-57 Appendix
 * E) to find the target event id.
 */
export function tallyZapReceipts(
  receipts: Array<{ id: string; tags: string[][] }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of receipts) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    for (const tag of r.tags) {
      if (tag[0] === 'e' && typeof tag[1] === 'string' && tag[1].length > 0) {
        counts.set(tag[1], (counts.get(tag[1]) ?? 0) + 1);
        break; // at most one `e` tag per receipt per NIP-57
      }
    }
  }
  return counts;
}

/**
 * Tally receipt records (zap-counts.ts shape) into `eventId → aggregate`,
 * restricted to receipts whose timestamp is in [sinceSec, untilSec].
 * Pure — used by the popular-list time-window filter + firehose floor.
 *
 * Pass `sinceSec = 0` and `untilSec = Infinity` for "all time". Null
 * eventIds (profile zaps, etc.) are skipped since they can't contribute
 * to any URL's ranking.
 */
export function tallyReceiptsInWindow(
  receipts: Array<{ id: string; eventId: string | null; ts: number; amountMsat: number }>,
  sinceSec: number,
  untilSec: number = Number.POSITIVE_INFINITY,
): Map<string, ZapAggregate> {
  const out = new Map<string, ZapAggregate>();
  const seen = new Set<string>();
  for (const r of receipts) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (!r.eventId) continue;
    if (r.ts < sinceSec || r.ts > untilSec) continue;
    const cur = out.get(r.eventId);
    if (cur) {
      cur.count += 1;
      cur.totalMsat += r.amountMsat;
    } else {
      out.set(r.eventId, { count: 1, totalMsat: r.amountMsat });
    }
  }
  return out;
}

/**
 * Extract the zapped amount (msats) from a NIP-57 receipt's tag set.
 * Tries the `description` tag first (raw zap-request JSON with an
 * `amount` tag) and falls back to parsing the BOLT-11 amount prefix.
 * Returns 0 when neither source yields a number.
 */
export function parseZapAmountMsat(tags: string[][]): number {
  // Fast path — the receipt's `description` is the raw zap request; its
  // `amount` tag (per NIP-57 Appendix D) carries the exact msat value
  // the wallet was asked to pay.
  const desc = tags.find((t) => t[0] === 'description')?.[1];
  if (desc) {
    try {
      const zr = JSON.parse(desc) as { tags?: string[][] };
      const amt = Array.isArray(zr.tags)
        ? zr.tags.find((t) => Array.isArray(t) && t[0] === 'amount')?.[1]
        : undefined;
      if (amt) {
        const n = Number.parseInt(amt, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // description wasn't JSON — fall through to bolt11.
    }
  }
  // Fallback: parse the BOLT-11 amount. Shape: `lnbc<digits><unit>...`
  // where unit ∈ {m, u, n, p} (milli/micro/nano/pico-BTC multipliers on
  // 1 BTC = 10^11 msat). Missing unit = whole BTC (rare for zaps).
  const bolt11 = tags.find((t) => t[0] === 'bolt11')?.[1];
  if (bolt11) {
    const m = /^lnbc(\d+)([munp])?/i.exec(bolt11);
    if (m) {
      const n = Number.parseInt(m[1] ?? '0', 10);
      const unit = (m[2] ?? '').toLowerCase();
      // BTC → msat multipliers: 1 BTC = 100_000_000_000 msat.
      //   m = 10^-3 BTC  → ×10^8 msat
      //   u = 10^-6 BTC  → ×10^5 msat
      //   n = 10^-9 BTC  → ×10^2 msat
      //   p = 10^-12 BTC → ×10^-1 msat (fractional, floored below)
      let msat = 0;
      if (unit === 'm')      msat = n * 1e8;
      else if (unit === 'u') msat = n * 1e5;
      else if (unit === 'n') msat = n * 1e2;
      else if (unit === 'p') msat = n / 10;
      else                   msat = n * 1e11;
      return Math.floor(msat);
    }
  }
  return 0;
}
