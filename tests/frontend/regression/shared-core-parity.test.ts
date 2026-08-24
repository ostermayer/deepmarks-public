// Structural guard: every PARITY-COPIED module MUST stay byte-identical
// between the web app and the browser extension. Two implementations
// drifting apart is exactly what caused the 2026-06 private-library
// wipe bug — the extension was missing the cross-version union
// recovery the web app had grown. There is no npm workspace to share
// a package through, so the contract is: one file, two copies, and
// this test.
//
// If this fails: copy the file you edited over the other one, e.g.
//   cp frontend/src/lib/nostr/private-set-core.ts \
//      browser-extension/src/lib/private-set-core.ts
// and run both suites.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const PARITY_PAIRS = [
  // chunk selection, per-item events, tombstone-aware merge
  ['frontend/src/lib/nostr/private-set-core.ts', 'browser-extension/src/lib/private-set-core.ts'],
  // canonical replaceable-bookmark conflict rule
  ['frontend/src/lib/nostr/bookmark-merge-core.ts', 'browser-extension/src/lib/bookmark-merge-core.ts'],
  // NIP-47 wallet client (preimage verification, timeout policy)
  ['frontend/src/lib/nostr/nwc.ts', 'browser-extension/src/lib/nwc.ts'],
  // nsec backup text + QR (recovery files must look the same everywhere)
  ['frontend/src/lib/nostr/nsec-backup.ts', 'browser-extension/src/lib/nsec-backup.ts'],
] as const;

describe('shared-module byte parity', () => {
  it.each(PARITY_PAIRS)('%s matches its extension copy', (frontendPath, extensionPath) => {
    expect(digest(`${root}/${frontendPath}`)).toBe(digest(`${root}/${extensionPath}`));
  });
});
