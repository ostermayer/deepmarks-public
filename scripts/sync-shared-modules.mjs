#!/usr/bin/env node
// Regenerate the checked-in copies of shared canonical modules
// (packages/*) into the packages that consume them. Docker build
// contexts are per-package, so a runtime workspace dependency can't
// reach the images — copies are checked in and this script plus the
// per-suite parity tests keep them from drifting.
//
//   node scripts/sync-shared-modules.mjs           # rewrite stale copies
//   node scripts/sync-shared-modules.mjs --check   # exit 1 on drift
//
// The parity tests import MODULES/headerFor from this file, so adding a
// module here automatically puts it under test.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODULES = [
  {
    canonical: 'packages/safe-url-core/safe-url-core.ts',
    targets: ['api/src/safe-url-core.ts', 'archive-worker/src/safe-url-core.ts'],
  },
  {
    canonical: 'packages/archive-wire/archive-wire.ts',
    targets: ['api/src/archive-wire.ts', 'archive-worker/src/archive-wire.ts'],
  },
  {
    canonical: 'packages/youtube-id/youtube-id.ts',
    targets: [
      'api/src/youtube-id.ts',
      'archive-worker/src/youtube-id.ts',
      'frontend/src/lib/youtube-id.ts',
      'browser-extension/src/lib/youtube-id.ts',
    ],
  },
];

export function headerFor(canonical) {
  return (
    '// GENERATED FILE — DO NOT EDIT.\n' +
    `// Source of truth: ${canonical}\n` +
    '// Regenerate with:  node scripts/sync-shared-modules.mjs\n' +
    '// A parity test in this package fails if this copy drifts.\n\n'
  );
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const check = process.argv.includes('--check');
  let drift = false;
  for (const { canonical, targets } of MODULES) {
    const expected = headerFor(canonical) + readFileSync(join(ROOT, canonical), 'utf8');
    for (const target of targets) {
      let current = null;
      try { current = readFileSync(join(ROOT, target), 'utf8'); } catch { /* missing */ }
      if (current === expected) continue;
      if (check) {
        console.error(`DRIFT: ${target} does not match ${canonical}`);
        drift = true;
      } else {
        writeFileSync(join(ROOT, target), expected);
        console.log(`synced ${target}`);
      }
    }
  }
  if (check && drift) process.exit(1);
  if (check && !drift) console.log('shared-module copies are in sync');
}

// Guarded so the parity tests can import MODULES without triggering a sync.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
