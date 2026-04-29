import { describe, it, expect } from 'vitest';
import { assertDeepmarksPubkey, config } from './config.js';

describe('config', () => {
  it('exposes the production defaults when no .env is set', () => {
    // The test runner doesn't set VITE_DEEPMARKS_RELAY etc, so the fallbacks
    // should be the strings we ship.
    expect(config.deepmarksRelay).toBe('wss://relay.deepmarks.org');
    expect(config.blossomUrl).toBe('https://blossom.deepmarks.org');
    expect(config.apiBase).toBe('https://api.deepmarks.org');
  });

  it('locks pricing constants against accidental drift', () => {
    expect(config.archivePriceSats).toBe(500);
    expect(config.lifetimePriceSats).toBe(21000);
  });

  it('lists at least one default outbox relay', () => {
    expect(config.defaultRelays.length).toBeGreaterThan(0);
    for (const url of config.defaultRelays) {
      expect(url).toMatch(/^wss:\/\//);
    }
  });
});

describe('assertDeepmarksPubkey', () => {
  it('returns the production brand pubkey by default', () => {
    // config.deepmarksPubkey now ships with a hardcoded fallback (the
    // production brand pubkey is non-secret and the home page breaks
    // entirely without it), so the assertion always returns a value
    // for forks / dev environments. Throw path is still wired in case
    // someone explicitly passes VITE_DEEPMARKS_PUBKEY=''.
    expect(assertDeepmarksPubkey()).toMatch(/^[0-9a-f]{64}$/);
  });
});
