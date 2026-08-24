import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES, ROOT, headerFor } from '../../../scripts/sync-shared-modules.mjs';

// Shared canonical modules (packages/*) are checked into each consuming
// package as generated copies because each package's Docker build
// context only contains its own directory. Drift between a copy and its
// canonical source is how SSRF fixes were hand-ported and how the
// worker's ArchiveJob lost `eventId` — this test turns drift into a
// failure instead of a silent hazard. The manifest is imported from the
// sync script, so adding a module there is automatically under test.
// Regenerate with:  node scripts/sync-shared-modules.mjs

describe('shared-module parity', () => {
  for (const { canonical, targets } of MODULES) {
    const expected = headerFor(canonical) + readFileSync(join(ROOT, canonical), 'utf8');
    for (const target of targets) {
      it(`${target} matches ${canonical}`, () => {
        expect(readFileSync(join(ROOT, target), 'utf8')).toBe(expected);
      });
    }
  }
});
