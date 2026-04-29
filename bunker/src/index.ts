// Entry point — loads config, vault, audit, starts the Fastify health
// server, starts the relay subscription loop. Graceful shutdown on
// SIGTERM/SIGINT so Docker's stop signal doesn't chop off mid-sign.

import 'dotenv/config';
import Fastify from 'fastify';

import { loadConfigFromEnv } from './config.js';
import { Vault } from './vault.js';
import { AuditLog } from './audit.js';
import { handleRequest } from './handler.js';
import { RelayConnection } from './relay.js';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
    },
  });

  // Vault load fails loud if any nsec file is missing or malformed; we
  // want the process to exit immediately so systemd / compose retries
  // instead of running in a half-broken state.
  const vault = Vault.load([
    { identity: 'brand', path: config.brandNsecPath },
    { identity: 'personal', path: config.personalNsecPath },
  ]);
  const audit = new AuditLog(config.auditPath);

  app.log.info(
    {
      relay: config.relayUrl,
      identities: vault.entries(),
      authorizedClient: config.clientPubkey,
      auditPath: audit.path,
    },
    'bunker starting',
  );

  // /health — Docker healthcheck + optional ops probe. Returns the
  // identity pubkeys we're managing so an operator can sanity-check at
  // a glance. Pubkeys are safe to log (they're the public half).
  app.get('/health', async () => ({
    ok: true,
    ts: Date.now(),
    identities: vault.entries(),
  }));

  await app.listen({ host: config.host, port: config.port });

  const relay = new RelayConnection(
    config.relayUrl,
    vault.entries().map((e) => e.pubkey),
    (ev) =>
      handleRequest(
        { vault, audit, authorizedClient: config.clientPubkey },
        ev,
      ),
    {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  );

  // Run the relay loop in the background; don't block boot so the
  // health endpoint becomes reachable while we're still connecting
  // to strfry (which may briefly be down during coordinated deploys).
  const relayTask = relay.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown requested');
    await relay.stop();
    await app.close();
    try {
      await relayTask;
    } catch {
      // relay.start rejected — fine during shutdown.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('bunker failed to start', err);
  process.exit(1);
});
