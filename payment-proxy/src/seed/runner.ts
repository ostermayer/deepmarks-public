// Shared daily Pinboard importer implementation. Called by:
//   - scripts/cli.ts        (one-shot from `npm run seed:pinboard`)
//   - workers/pinboard-seeder.ts (scheduled from index.ts at boot + interval)
//
// Pure control flow lives here; I/O is parameterised so the scheduled variant
// can reuse its own pool and the one-shot can exit cleanly.

import { SimplePool, type EventTemplate, type Event as NostrEvent } from 'nostr-tools';
import { dedupe, parsePinboardPage, type PinboardEntry } from './pinboard.js';
import type { RemoteSigner } from '../signer.js';

const POPULAR_SOURCE = 'https://pinboard.in/popular/';
const UA = 'Deepmarks-Daily-Pinboard/1.0 (+https://deepmarks.org)';
const PUBLISH_PAUSE_MS = 200;
const NIP89_CLIENT_TAG = [
  'client',
  'Deepmarks',
  '31990:2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4:deepmarks',
] as const;

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
  socialOk: number;
  socialFailed: number;
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

export function buildBookmarkTemplate(entry: PinboardEntry): EventTemplate {
  const tags: string[][] = [
    ['d', entry.url],
    ['title', entry.title],
    ['source', 'pinboard:popular'],
  ];
  if (entry.description) tags.push(['description', entry.description]);
  for (const t of entry.tags) tags.push(['t', t]);
  tags.push(['t', 'pinboard'], ['t', 'popular']);
  tags.push([...NIP89_CLIENT_TAG]);
  return {
    kind: 39701,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags,
  };
}

function truncate(input: string, max: number): string {
  const clean = input.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function buildSocialPostContent(entry: PinboardEntry): string {
  const title = truncate(entry.title || entry.url, 180);
  const description = entry.description ? truncate(entry.description, 260) : '';
  return [title, description, entry.url].filter(Boolean).join('\n\n');
}

export function buildSocialPostTemplate(entry: PinboardEntry, bookmark: NostrEvent): EventTemplate {
  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: buildSocialPostContent(entry),
    tags: [
      ['r', entry.url],
      ['a', `39701:${bookmark.pubkey}:${entry.url}`],
      ['t', 'deepmarks'],
      ['t', 'pinboard'],
      [...NIP89_CLIENT_TAG],
    ],
  };
}

export interface SeedOptions {
  apply: boolean;
  /** Relay URLs to consider. Unreachable ones are probed out before publishing. */
  candidateRelays: string[];
  pool?: SimplePool;
  logger?: SeedLogger;
  /** Signer for the public profile identity (kind 39701 + kind 1 daily posts). */
  signer: RemoteSigner;
}

/**
 * Run the seeder once. Idempotent — skips URLs the deepmarks pubkey has already
 * published. Returns counts for logging / tests.
 */
export async function seedOnce(opts: SeedOptions): Promise<SeedResult> {
  const log = opts.logger ?? noopLogger;
  const publicProfilePubkey = opts.signer.pubkey;

  log.info(`pinboard daily identity: ${publicProfilePubkey}`);

  // 1. Fetch
  log.info(`fetching ${POPULAR_SOURCE}…`);
  const html = await fetchSource(POPULAR_SOURCE);

  // 2. Parse + dedupe + keep Pinboard's popularity order, using count as
  // a robust tie-breaker when the page exposes it.
  const rawEntries = parsePinboardPage(html);
  const unique = dedupe(rawEntries);
  const ordered = unique
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.count ?? 0) - (a.entry.count ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
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
      socialOk: 0,
      socialFailed: 0,
      perRelayFailures: {},
    };
  }
  log.info(`  using: ${relays.join(', ')}`);

  const pool = opts.pool ?? new SimplePool();
  const ownsPool = !opts.pool;

  try {
    // 4. Skip already-published
    log.info(`querying relays for existing public-profile bookmarks…`);
    const existing = await alreadyPublishedUrls(pool, publicProfilePubkey, relays);
    const fresh = ordered.filter((e) => !existing.has(e.url));
    const selected = fresh[0];
    log.info(`  ${existing.size} already published, ${fresh.length} fresh popular candidates`);

    if (!opts.apply) {
      return {
        fetched: rawEntries.length,
        unique: unique.length,
        alreadyPublished: existing.size,
        fresh: selected ? 1 : 0,
        ok: 0,
        failed: 0,
        socialOk: 0,
        socialFailed: 0,
        perRelayFailures: {},
      };
    }

    if (!selected) {
      log.info('no fresh Pinboard popular bookmark to publish today');
      return {
        fetched: rawEntries.length,
        unique: unique.length,
        alreadyPublished: existing.size,
        fresh: 0,
        ok: 0,
        failed: 0,
        socialOk: 0,
        socialFailed: 0,
        perRelayFailures: {},
      };
    }

    // 5. Sign + publish exactly one bookmark, then cross-post it as a
    // public-profile social note when at least one relay accepted the
    // bookmark event.
    const perRelayFailures: Record<string, number> = {};
    let ok = 0;
    let failed = 0;
    let socialOk = 0;
    let socialFailed = 0;

    const event = await opts.signer.sign(buildBookmarkTemplate(selected));
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

    if (accepted > 0) {
      await new Promise((r) => setTimeout(r, PUBLISH_PAUSE_MS));
      try {
        const social = await opts.signer.sign(buildSocialPostTemplate(selected, event));
        const socialResults = await Promise.allSettled(pool.publish(relays, social));
        const socialAccepted = socialResults.filter((r) => r.status === 'fulfilled').length;
        socialResults.forEach((r, i) => {
          if (r.status === 'rejected') {
            const url = relays[i] ?? '';
            perRelayFailures[url] = (perRelayFailures[url] ?? 0) + 1;
          }
        });
        if (socialAccepted > 0) socialOk++;
        else socialFailed++;
      } catch (err) {
        socialFailed++;
        log.warn(`social cross-post failed: ${(err as Error).message}`);
      }
    }

    log.info(`pinboard daily: ${ok} bookmark, ${socialOk} social note (${failed + socialFailed} failed)`);
    return {
      fetched: rawEntries.length,
      unique: unique.length,
      alreadyPublished: existing.size,
      fresh: 1,
      ok,
      failed,
      socialOk,
      socialFailed,
      perRelayFailures,
    };
  } finally {
    if (ownsPool) pool.close(relays);
  }
}

/** Default relay list — indexer + public fallback relays. Used by both runners. */
export function defaultCandidateRelays(): string[] {
  return [
    process.env.INDEXER_RELAY_URL ?? 'wss://relay.deepmarks.org',
    'wss://nos.lol',
    'wss://relay.primal.net',
  ];
}
