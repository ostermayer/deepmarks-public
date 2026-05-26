import { afterEach, describe, it, expect, vi } from 'vitest';

const ENV_KEYS = [
  'VITE_DEEPMARKS_RELAY',
  'VITE_BLOSSOM_URL',
  'VITE_API_BASE',
  'VITE_DEEPMARKS_LN_ADDRESS',
  'VITE_DEEPMARKS_PUBKEY',
  'VITE_DEEPMARKS_SEEDER_PUBKEY',
] as const;

async function loadConfigWithEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  vi.resetModules();
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, overrides[key] ?? '');
  }
  return await import('./config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config', () => {
  it('exposes the production defaults when no .env is set', async () => {
    const { config } = await loadConfigWithEnv();
    // The test runner doesn't set VITE_DEEPMARKS_RELAY etc, so the fallbacks
    // should be the strings we ship.
    expect(config.deepmarksRelay).toBe('wss://relay.deepmarks.org');
    expect(config.blossomUrl).toBe('https://blossom.deepmarks.org');
    expect(config.apiBase).toBe('https://api.deepmarks.org');
  });

  it('locks lifetime pricing constants against accidental drift', async () => {
    const { config } = await loadConfigWithEnv();
    expect(config.lifetimePriceSats).toBe(21000);
  });

  it('keeps defaultRelays empty under the server-mediated publish model', async () => {
    // Older builds seeded public relays (nos.lol, primal) so NDK had
    // something to talk to. With clients now POSTing signed events to
    // /publish and the server fanning out / ingesting from NIP-65, the
    // static seed list is no longer wanted — NDK's outbox model still
    // dynamically adds curator relays when needed. Locking the test to
    // "empty by default" so we notice if the seed list silently grows
    // again.
    const { config } = await loadConfigWithEnv();
    expect(config.defaultRelays.length).toBe(0);
  });
});

describe('assertDeepmarksPubkey', () => {
  it('returns the production brand/social pubkey by default', async () => {
    const { assertDeepmarksPubkey } = await loadConfigWithEnv();
    // config.deepmarksPubkey now ships with a hardcoded fallback (the
    // production brand/social pubkey is non-secret), so the assertion
    // always returns a value for forks / dev environments. Throw path is
    // still wired in case someone explicitly passes VITE_DEEPMARKS_PUBKEY=''.
    expect(assertDeepmarksPubkey()).toBe(
      '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4'
    );
  });
});

describe('deepmarks owned pubkeys', () => {
  it('keeps the landing feed pointed at the public brand/social daily importer key', async () => {
    const { config } = await loadConfigWithEnv({
      VITE_DEEPMARKS_PUBKEY: '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4',
    });

    expect(config.deepmarksPubkey).toBe(
      '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4',
    );
    expect(config.deepmarksSeederPubkey).toBe(
      '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4',
    );
    expect(config.landingFeedPubkeys).toEqual([
      '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4',
    ]);
    expect(config.deepmarksEditorialPubkeys).toEqual([
      '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4',
      '7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800',
    ]);
  });
});
