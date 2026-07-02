import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: false }));

describe('archive key chunk merging', () => {
  it('uses stale chunks as fallback without overwriting matching-version keys', async () => {
    const { mergeArchiveKeyPlaintextChunks } = await import('$lib/nostr/archive-keys.js');

    const merged = mergeArchiveKeyPlaintextChunks([
      {
        plaintext: JSON.stringify({ shared: 'old-key', staleOnly: 'stale-key' }),
        index: 1,
        versionMatches: false,
      },
      {
        plaintext: JSON.stringify({ shared: 'new-key', currentOnly: 'current-key' }),
        index: 0,
        versionMatches: true,
      },
    ]);

    expect(merged).toEqual({
      shared: 'new-key',
      currentOnly: 'current-key',
      staleOnly: 'stale-key',
    });
  });

  it('skips corrupt or non-object plaintext chunks', async () => {
    const { mergeArchiveKeyPlaintextChunks } = await import('$lib/nostr/archive-keys.js');

    const merged = mergeArchiveKeyPlaintextChunks([
      { plaintext: 'not-json', index: 0, versionMatches: true },
      { plaintext: JSON.stringify(['bad-shape']), index: 1, versionMatches: true },
      { plaintext: JSON.stringify({ ok: 'key' }), index: 2, versionMatches: true },
    ]);

    expect(merged).toEqual({ ok: 'key' });
  });
});
