// Standalone worker-process entrypoint.
//
// `node dist/worker.js` runs ONE worker group, selected by the
// WORKER_GROUP env var (or argv[2]): search-indexer | relay-sync |
// enrichment | payments | all. Each group runs in its own container off
// the SAME image as the API (deploy/box-a/compose.yml sets the command +
// group), so there's no second package to keep in sync.
//
// The API process can still host the whole fleet in-process via
// RUN_WORKERS=all (see index.ts) — that's the dev / single-box path. In
// production the API runs RUN_WORKERS=none and these processes own the
// workers.

import 'dotenv/config';

import { buildWorkerDeps, isWorkerGroup, type WorkerGroup } from './worker-deps.js';
import { buildWorkerGroup } from './workers-bootstrap.js';
import { startStatsHeartbeat } from './worker-stats.js';

function resolveGroup(): WorkerGroup {
  const raw = (process.env.WORKER_GROUP ?? process.argv[2] ?? '').trim();
  const allowed = 'search-indexer | relay-sync | enrichment | payments | all';
  if (!raw) throw new Error(`WORKER_GROUP not set — expected one of: ${allowed}`);
  if (!isWorkerGroup(raw)) throw new Error(`unknown WORKER_GROUP "${raw}" — expected one of: ${allowed}`);
  return raw;
}

async function main(): Promise<void> {
  const group = resolveGroup();
  const wd = await buildWorkerDeps(group);
  const handle = buildWorkerGroup(wd, group);

  handle.start();
  const stopHeartbeat = startStatsHeartbeat(wd.redis, handle.statsSources, wd.logger);
  wd.logger.info(
    { group, workers: handle.statsSources.map((s) => s.name) },
    'worker group started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    wd.logger.info({ signal, group }, 'worker shutting down');
    try {
      stopHeartbeat();
      await handle.stop();
      wd.signers?.closeAll();
      wd.relayPool.close([]);
      wd.redis.disconnect();
    } catch (err) {
      wd.logger.error({ err }, 'error during worker shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal worker startup error', err);
  process.exit(1);
});
