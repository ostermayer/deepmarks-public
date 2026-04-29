// Shared seeding implementation. Called by:
//   - scripts/cli.ts        (one-shot from `npm run seed:pinboard`)
//   - workers/pinboard-seeder.ts (scheduled from index.ts at boot + interval)
//
// Pure control flow lives here; I/O is parameterised so the scheduled variant
// can reuse its own pool and the one-shot can exit cleanly.

import { SimplePool, type EventTemplate, type Event as NostrEvent } from 'nostr-tools';
import { dedupe, parsePinboardPage, shuffle, type PinboardEntry } from './pinboard.js';
import type { RemoteSigner } from '../signer.js';

const SOURCES = [
  'https://pinboard.in/popular/',
  'https://pinboard.in/recent/',
];

const UA = 'Deepmarks-Seeder/1.0 (+https://deepmarks.org)';
const TIMESTAMP_WINDOW_DAYS = 7;
const PUBLISH_PAUSE_MS = 200;

export interface SeedLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: SeedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface SeedResult {
  fetched: number;
  unique: number;
  alreadyPublished: number;
  fresh: number;
  ok: number;
  failed: number;
  perRelayFailures: Record<string, number>;
}

async function probeRelay(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); finish(true); };
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function fetchSource(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function alreadyPublishedUrls(
  pool: SimplePool,
  pubkey: string,
  relays: string[],
): Promise<Set<string>> {
  const urls = new Set<string>();
  await new Promise<void>((resolve) => {
    const sub = pool.subscribeMany(
      relays,
      { kinds: [39701], authors: [pubkey], limit: 5000 },
      {
        onevent: (e: NostrEvent) => {
          const d = e.tags.find((t) => t[0] === 'd')?.[1];
          if (d) urls.add(d);
        },
        oneose: () => { sub.close(); resolve(); },
      },
    );
    setTimeout(() => { sub.close(); resolve(); }, 10_000);
  });
  return urls;
}

function buildBookmarkTemplate(entry: PinboardEntry): EventTemplate {
  const offset = Math.floor(Math.random() * TIMESTAMP_WINDOW_DAYS * 86_400);
  const tags: string[][] = [
    ['d', entry.url],
    ['title', entry.title],
  ];
  if (entry.description) tags.push(['description', entry.description]);
  for (const t of entry.tags) tags.push(['t', t]);
  return {
    kind: 39701,
    created_at: Math.floor(Date.now() / 1000) - offset,
    content: '',
    tags,
  };
}

export interface SeedOptions {
  apply: boolean;
  /** Relay URLs to consider. Unreachable ones are probed out before publishing. */
  candidateRelays: string[];
  pool?: SimplePool;
  logger?: SeedLogger;
  /** Signer for the brand identity (kind 39701 seed events). */
  signer: RemoteSigner;
}

/**
 * Run the seeder once. Idempotent — skips URLs the deepmarks pubkey has already
 * published. Returns counts for logging / tests.
 */
export async function seedOnce(opts: SeedOptions): Promise<SeedResult> {
  const log = opts.logger ?? noopLogger;
  const brandPubkey = opts.signer.pubkey;

  log.info(`seeder identity: ${brandPubkey}`);

  // 1. Fetch
  log.info(`fetching ${SOURCES.length} pinboard pages…`);
  const htmls = await Promise.all(SOURCES.map(fetchSource));

  // 2. Parse + dedupe + shuffle
  const rawEntries = htmls.flatMap(parsePinboardPage);
  const unique = dedupe(rawEntries);
  const ordered = shuffle(unique);
  log.info(`  parsed ${rawEntries.length} entries → ${unique.length} unique`);

  // 3. Probe relays
  const probes = await Promise.all(
    opts.candidateRelays.map(async (url) => ({ url, alive: await probeRelay(url) })),
  );
  const relays = Array.from(new Set(probes.filter((p) => p.alive).map((p) => p.url)));
  const dead = probes.filter((p) => !p.alive).map((p) => p.url);
  if (dead.length > 0) log.warn(`  skipping unreachable: ${dead.join(', ')}`);
  if (relays.length === 0) {
    log.error('no reachable relays — aborting this run');
    return {
      fetched: rawEntries.length,
      unique: unique.length,
      alreadyPublished: 0,
      fresh: 0,
      ok: 0,
      failed: 0,
      perRelayFailures: {},
    };
  }
  log.info(`  using: ${relays.join(', ')}`);

  const pool = opts.pool ?? new SimplePool();
  const ownsPool = !opts.pool;

  try {
    // 4. Skip already-published
    log.info(`querying relays for existing deepmarks bookmarks…`);
    const existing = await alreadyPublishedUrls(pool, brandPubkey, relays);
    const fresh = ordered.filter((e) => !existing.has(e.url));
    log.info(`  ${existing.size} already published, ${fresh.length} new`);

    if (!opts.apply) {
      return {
        fetched: rawEntries.length,
        unique: unique.length,
        alreadyPublished: existing.size,
        fresh: fresh.length,
        ok: 0,
        failed: 0,
        perRelayFailures: {},
      };
    }

    // 5. Sign + publish
    const perRelayFailures: Record<string, number> = {};
    let ok = 0;
    let failed = 0;
    for (const entry of fresh) {
      const event = await opts.signer.sign(buildBookmarkTemplate(entry));
      const results = await Promise.allSettled(pool.publish(relays, event));
      const accepted = results.filter((r) => r.status === 'fulfilled').length;
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const url = relays[i] ?? '';
          perRelayFailures[url] = (perRelayFailures[url] ?? 0) + 1;
        }
      });
      if (accepted > 0) ok++;
      else failed++;
      await new Promise((r) => setTimeout(r, PUBLISH_PAUSE_MS));
    }

    log.info(`seeded ${ok} events, ${failed} failed`);
    return {
      fetched: rawEntries.length,
      unique: unique.length,
      alreadyPublished: existing.size,
      fresh: fresh.length,
      ok,
      failed,
      perRelayFailures,
    };
  } finally {
    if (ownsPool) pool.close(relays);
  }
}

/** Default relay list — indexer + damus + nos.lol. Used by both runners. */
export function defaultCandidateRelays(): string[] {
  return [
    process.env.INDEXER_RELAY_URL ?? 'wss://relay.deepmarks.org',
    'wss://relay.damus.io',
    'wss://nos.lol',
  ];
}
