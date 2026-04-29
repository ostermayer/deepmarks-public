// One-shot CLI around the shared seedOnce() runner.
//
//   npm run seed:pinboard               # dry run
//   npm run seed:pinboard -- --apply    # publish to relays
//   npm run seed:pinboard -- --apply --verbose

import 'dotenv/config';
import { defaultCandidateRelays, seedOnce, type SeedLogger } from './runner.js';
import { BunkerSigner, loadSignerConfigFromEnv } from '../signer.js';

interface CliOpts { apply: boolean; verbose: boolean }

function parseFlags(argv: string[]): CliOpts {
  return {
    apply: argv.includes('--apply'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };
}

const logger: SeedLogger = {
  // eslint-disable-next-line no-console
  info: (msg) => console.log(msg),
  // eslint-disable-next-line no-console
  warn: (msg) => console.warn(msg),
  // eslint-disable-next-line no-console
  error: (msg) => console.error(msg),
};

async function main(): Promise<void> {
  const opts = parseFlags(process.argv.slice(2));
  // The seeder signs kind:39701 as the brand identity, which means the
  // brand signer in the Box C bunker has to be reachable from wherever
  // you run this CLI. In practice that's Box A itself (where the
  // BUNKER_RELAY_URL points at strfry on the VPC). Running from a
  // laptop requires setting up a relay the laptop + bunker both reach.
  const signerConfig = loadSignerConfigFromEnv();
  const signer = new BunkerSigner({
    identityPubkey: signerConfig.brandPubkey,
    clientNsec: signerConfig.clientNsec,
    relayUrl: signerConfig.relayUrl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    const result = await seedOnce({
      apply: opts.apply,
      candidateRelays: defaultCandidateRelays(),
      logger,
      signer,
    });
    emit(result, opts.apply);
  } finally {
    signer.close();
  }
}

function emit(result: Awaited<ReturnType<typeof seedOnce>>, apply: boolean): void {
  // eslint-disable-next-line no-console
  console.log(
    `\nsummary: +${result.ok} seeded, ${result.failed} failed, ${result.alreadyPublished} already present`,
  );
  if (Object.keys(result.perRelayFailures).length > 0) {
    // eslint-disable-next-line no-console
    console.log('per-relay failures:');
    for (const [url, n] of Object.entries(result.perRelayFailures)) {
      // eslint-disable-next-line no-console
      console.log(`  ${url}: ${n} rejections`);
    }
  }
  if (!apply) {
    // eslint-disable-next-line no-console
    console.log('\n[dry-run] re-run with --apply to publish.');
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seeder failed:', err);
  process.exit(1);
});
