// /admin/dashboard — one JSON aggregate for the operator UI.
//
// The frontend at /app/admin/dashboard polls this every few seconds.
// Pulled into one route so the page makes one round-trip per refresh
// instead of fanning out to N admin endpoints.
//
// What we report:
//   - boxes: which subsystems payment-proxy is in contact with right
//     now (Redis, Meilisearch, strfry, the archive worker via its
//     callback HMAC pulse, Voltage LN). Each carries an `ok` boolean +
//     a one-line status string + latencyMs where it makes sense.
//   - relay: event counts per kind on our local strfry, total stored
//     events, registered-pubkey count, watched-contact count.
//   - queues: depth of every Redis LIST used as a worker queue
//     (onboarding, lifetime-archive, pending-publish, archive).
//   - workers: each worker's public `stats` object (defined on the
//     class). Adding a new worker stat shows up here automatically.
//   - alerts: most-recent N alerts the Tier-1 alerter has fired.
//
// Auth: NIP-98 admin gate. The page is at /app/admin/dashboard and
// signs requests with the operator's own nsec (no separate admin
// session — the same admin pubkey set that gates other /admin/*).

import type { Deps } from '../route-deps.js';
import type { Workers } from '../workers-bootstrap.js';

const RELAY_QUERY_TIMEOUT_MS = 3_000;

interface BoxStatus {
  ok: boolean;
  status: string;
  latencyMs?: number;
}

interface DashboardResponse {
  ts: number;
  boxes: {
    redis: BoxStatus;
    meilisearch: BoxStatus;
    strfry: BoxStatus;
    voltage: BoxStatus;
    archiveWorker: BoxStatus;
    bunker: BoxStatus;
  };
  relay: {
    url: string;
    registeredPubkeys: number;
    watchedContacts: number;
    eventCounts: Record<string, number>;
  };
  queues: Record<string, number>;
  workers: Record<string, unknown>;
  alerts: Array<{ key: string; severity: string; subject: string; sentAt: number }>;
}

/** Probe Redis with a PING; return ok + roundtrip ms. */
async function pingRedis(redis: Deps['redis']): Promise<BoxStatus> {
  const t0 = Date.now();
  try {
    const reply = await redis.ping();
    return { ok: reply === 'PONG', status: reply === 'PONG' ? 'connected' : `unexpected: ${reply}`, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: (err as Error).message ?? 'ping failed', latencyMs: Date.now() - t0 };
  }
}

/** Probe Meilisearch /health. */
async function pingMeili(meili: Deps['meili']): Promise<BoxStatus> {
  const t0 = Date.now();
  try {
    const ok = await meili.healthy();
    return { ok, status: ok ? 'healthy' : 'unhealthy', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, status: (err as Error).message ?? 'unreachable', latencyMs: Date.now() - t0 };
  }
}

/** Probe strfry: query a single recent event with a tiny limit.
 *  If the relay is up, EOSE comes back fast; if it's down, the timeout fires. */
async function pingStrfry(
  pool: Deps['relayPool'],
  relayUrl: string,
): Promise<BoxStatus> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (s: BoxStatus): void => {
      if (resolved) return;
      resolved = true;
      try { sub.close(); } catch { /* already closed */ }
      resolve(s);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 'EOSE timeout', latencyMs: Date.now() - t0 }), RELAY_QUERY_TIMEOUT_MS);
    const sub = pool.subscribeMany(
      [relayUrl],
      { kinds: [1], limit: 1 } as never,
      {
        onevent: () => undefined,
        oneose: () => { clearTimeout(timer); finish({ ok: true, status: 'EOSE received', latencyMs: Date.now() - t0 }); },
      },
    );
  });
}

/** Voltage status. The invoice-only macaroon can't call getInfo (missing
 *  info:read scope), so a per-poll handshake would be too heavy. Instead
 *  we just report whether the lnd handle is initialised and whether the
 *  startup handshake has stamped the most-recent connection-OK time. */
async function voltageStatus(
  lnd: Deps['lnd'],
  redis: Deps['redis'],
): Promise<BoxStatus> {
  if (!lnd) return { ok: false, status: 'not configured' };
  try {
    const last = await redis.get('dm:voltage:last-ok');
    if (!last) return { ok: true, status: 'configured, no handshake stamp yet' };
    const ageMs = Date.now() - Number.parseInt(last, 10);
    if (ageMs > 6 * 60 * 60 * 1000) return { ok: false, status: `last handshake ${Math.round(ageMs / 60_000)} min ago` };
    return { ok: true, status: `last handshake ${Math.round(ageMs / 60_000)} min ago` };
  } catch {
    return { ok: !!lnd, status: 'handle initialised' };
  }
}

/** The archive worker on Box B can't be reached directly — payment-proxy
 *  is the inbound side of /archive/callback. We approximate health by
 *  looking at the most recent successful callback timestamp stamped in
 *  Redis by the callback handler. Stale > 30 min => warn. */
async function archiveWorkerStatus(redis: Deps['redis']): Promise<BoxStatus> {
  try {
    const last = await redis.get('dm:archive-worker:last-callback');
    if (!last) return { ok: false, status: 'no callbacks received yet' };
    const ageMs = Date.now() - Number.parseInt(last, 10);
    if (ageMs > 30 * 60 * 1000) return { ok: false, status: `last callback ${Math.round(ageMs / 60_000)} min ago` };
    return { ok: true, status: `last callback ${Math.round(ageMs / 1_000)}s ago` };
  } catch (err) {
    return { ok: false, status: (err as Error).message ?? 'redis read failed' };
  }
}

/** The bunker (Box C) is reachable only by signing a NIP-46 RPC. The
 *  cheapest health check is "do we have a signer with a known pubkey?"
 *  — the signer set is built at boot and rejects sign attempts if the
 *  bunker connection is down. If signers.brand.pubkey is set, the
 *  handshake succeeded. */
function bunkerStatus(signers: Deps['signers']): BoxStatus {
  const brand = signers.brand?.pubkey;
  const personal = signers.personal?.pubkey;
  if (!brand || !personal) return { ok: false, status: 'signers not initialised' };
  return { ok: true, status: `signers brand=${brand.slice(0, 8)}… personal=${personal.slice(0, 8)}…` };
}

/** Count events of each kind on strfry. Bounded query (limit 1) per
 *  kind — we use COUNT via Redis-cached counters where they exist, and
 *  fall back to a small per-kind probe. */
async function relayEventCounts(
  redis: Deps['redis'],
): Promise<Record<string, number>> {
  // payment-proxy maintains kind:39701 author counts in
  // dm:public-bookmarks:author:<pubkey> ZSETs; we don't have a single
  // global counter. Use the relay-stats helper sets if present,
  // otherwise return what we can pull cheaply from Redis-cached
  // tallies. Operator can drill into per-pubkey via /admin/relay-stats.
  const [pubBookmarks, privChunks, profiles, contacts, nip65, archiveLabels, zapReceipts, registrations] = await Promise.all([
    redis.get('dm:relay-counter:39701').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:30003').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:0').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:3').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:10002').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:1985').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:9735').then((v) => Number(v ?? 0)).catch(() => 0),
    redis.get('dm:relay-counter:24133').then((v) => Number(v ?? 0)).catch(() => 0),
  ]);
  return {
    '39701_public_bookmarks': pubBookmarks,
    '30003_private_chunks': privChunks,
    '0_profiles': profiles,
    '3_contacts': contacts,
    '10002_nip65': nip65,
    '1985_labels': archiveLabels,
    '9735_zap_receipts': zapReceipts,
    '24133_nip46': registrations,
  };
}

async function queueDepths(redis: Deps['redis']): Promise<Record<string, number>> {
  const queues = [
    'dm:onboarding:queue',
    'dm:lifetime-archive:queue',
    'dm:pending-publish:queue',
    'dm:archive:queue',
  ];
  const lens = await Promise.all(
    queues.map((q) => redis.llen(q).catch(() => 0)),
  );
  const out: Record<string, number> = {};
  queues.forEach((q, i) => { out[q] = lens[i] ?? 0; });
  return out;
}

async function recentAlerts(redis: Deps['redis']): Promise<DashboardResponse['alerts']> {
  // The alerter stamps recent alerts into a capped Redis list.
  // If the key doesn't exist (e.g. fresh boot), return empty.
  try {
    const raw = await redis.lrange('dm:alerter:recent', 0, 19);
    return raw
      .map((s) => {
        try { return JSON.parse(s) as DashboardResponse['alerts'][number]; }
        catch { return null; }
      })
      .filter((x): x is DashboardResponse['alerts'][number] => !!x);
  } catch {
    return [];
  }
}

export function register(deps: Deps, workers: Workers): void {
  const {
    app, redis, meili, relayPool, lnd, signers,
    INDEXER_RELAY_URL_FOR_API, requireAdmin,
  } = deps;

  app.get('/admin/dashboard', async (request, reply) => {
    const auth = await requireAdmin({
      headers: request.headers,
      url: '/admin/dashboard',
      method: 'GET',
    });
    if (!auth.ok) return reply.status(auth.status ?? 401).send({ error: auth.reason });

    const [
      redisStatus, meiliStatus, strfryStatus, voltageStatusBox,
      archiveStatus, eventCounts, registered, watched, queues, alerts,
    ] = await Promise.all([
      pingRedis(redis),
      pingMeili(meili),
      pingStrfry(relayPool, INDEXER_RELAY_URL_FOR_API),
      voltageStatus(lnd, redis),
      archiveWorkerStatus(redis),
      relayEventCounts(redis),
      redis.scard('dm:registered:pubkeys').catch(() => 0),
      redis.scard('dm:contacts:watched').catch(() => 0),
      queueDepths(redis),
      recentAlerts(redis),
    ]);

    const body: DashboardResponse = {
      ts: Date.now(),
      boxes: {
        redis: redisStatus,
        meilisearch: meiliStatus,
        strfry: strfryStatus,
        voltage: voltageStatusBox,
        archiveWorker: archiveStatus,
        bunker: bunkerStatus(signers),
      },
      relay: {
        url: INDEXER_RELAY_URL_FOR_API,
        registeredPubkeys: registered,
        watchedContacts: watched,
        eventCounts,
      },
      queues,
      workers: {
        relayFanout: workers.relayFanout.stats,
        onboardingScanner: workers.onboardingScanner.stats,
        lifetimeArchiveBackfill: workers.lifetimeArchiveBackfill.stats,
        followsIngester: workers.followsIngester.stats,
      },
      alerts,
    };

    reply.header('cache-control', 'no-store');
    return body;
  });
}
