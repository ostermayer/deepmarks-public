// Cross-process worker stats, published to Redis.
//
// `/admin/dashboard` used to read each worker's in-memory `.stats`
// object directly (workers ran in the same process as the HTTP server).
// Once workers move to their own processes that memory is no longer
// reachable from the API, so every process that hosts workers writes
// their stats to Redis on a heartbeat and the dashboard reads them back.
// This path is uniform: it runs the same way whether workers are
// in-process (RUN_WORKERS=all) or split out into worker containers.

import type { Redis } from 'ioredis';
import type { WorkerLogger } from './worker-logger.js';

export const WORKER_STATS_PREFIX = 'dm:worker-stats:';
/** Key TTL. Comfortably longer than HEARTBEAT_INTERVAL_MS so a live
 *  worker never expires between beats, but short enough that a dead
 *  worker drops off the dashboard within a couple of minutes. */
export const WORKER_STATS_TTL_SECONDS = 120;
const HEARTBEAT_INTERVAL_MS = 15_000;

/** A worker that exposes a live `stats` object for the dashboard. */
export interface StatsSource {
  /** Stable key the dashboard looks the worker up by (e.g. 'relayFanout'). */
  name: string;
  /** Returns the current stats snapshot (plain JSON-serialisable object). */
  getStats: () => unknown;
}

export async function publishWorkerStats(
  redis: Redis,
  name: string,
  stats: unknown,
): Promise<void> {
  const payload = JSON.stringify({ ...(stats as object), heartbeatAt: Date.now() });
  await redis.set(WORKER_STATS_PREFIX + name, payload, 'EX', WORKER_STATS_TTL_SECONDS);
}

export async function readWorkerStats(
  redis: Redis,
  name: string,
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(WORKER_STATS_PREFIX + name);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Begin heartbeating the given stats sources to Redis. Writes once
 * immediately, then every HEARTBEAT_INTERVAL_MS. Returns a stop function
 * that clears the timer (call it on shutdown).
 */
export function startStatsHeartbeat(
  redis: Redis,
  sources: StatsSource[],
  logger: WorkerLogger,
): () => void {
  if (sources.length === 0) return () => {};

  const beat = (): void => {
    void Promise.all(
      sources.map((s) =>
        publishWorkerStats(redis, s.name, s.getStats()).catch((err) =>
          logger.warn({ err, worker: s.name }, 'worker stats heartbeat failed'),
        ),
      ),
    );
  };

  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive solely for the heartbeat.
  timer.unref?.();
  return () => clearInterval(timer);
}
