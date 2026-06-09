// Structural guard: the private-set core (chunk selection, per-item
// events, tombstone-aware merge) MUST stay byte-identical between the
// web app and the browser extension. The two implementations drifting
// apart is exactly what caused the 2026-06 private-library wipe bug —
// the extension was missing the cross-version union recovery the web
// app had grown. There is no npm workspace to share a package through,
// so the contract is: one file, two copies, and this test.
//
// If this fails: copy the file you edited over the other one
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

describe('private-set-core byte parity', () => {
  it('frontend and extension copies are identical', () => {
    const frontend = digest(`${root}/frontend/src/lib/nostr/private-set-core.ts`);
    const extension = digest(`${root}/browser-extension/src/lib/private-set-core.ts`);

    expect(frontend).toBe(extension);
  });
});
