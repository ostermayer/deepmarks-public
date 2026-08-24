import { describe, expect, it, vi } from 'vitest';
import { isSavePageNowEnabled, maybeSubmitToSavePageNow } from '../../api/src/wayback-spn.js';

/** Stateful fake of the one Redis call the module makes: SET key '1' EX n NX.
 *  Returns 'OK' the first time a key is claimed, null afterwards (NX miss). */
function fakeRedis() {
  const keys = new Set<string>();
  return {
    keys,
    set: vi.fn(async (k: string): Promise<'OK' | null> => (keys.has(k) ? null : (keys.add(k), 'OK'))),
  };
}

function res(init: { status: number; json?: unknown }): Response {
  return {
    ok: init.status < 400,
    status: init.status,
    json: async () => init.json ?? {},
  } as unknown as Response;
}

const ON = { WAYBACK_SPN_ENABLED: '1' } as NodeJS.ProcessEnv;

describe('wayback save-page-now', () => {
  it('parses only truthy enable flags', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isSavePageNowEnabled({ WAYBACK_SPN_ENABLED: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off', undefined]) {
      expect(isSavePageNowEnabled({ WAYBACK_SPN_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('does nothing when disabled — no network, no redis claim', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn();
    const out = await maybeSubmitToSavePageNow(redis, 'https://example.com/p', {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ submitted: false, skipped: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects non-public URLs (no localhost, no schemeless, http(s) only)', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn();
    for (const url of ['ftp://example.com', 'http://localhost/x', 'not a url', 'https://nodothost/x']) {
      const out = await maybeSubmitToSavePageNow(redis, url, { env: ON, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(out.skipped).toBe('invalid-url');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('submits anonymously, then dedupes the same URL', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn(async () => res({ status: 200 }));
    const first = await maybeSubmitToSavePageNow(redis, 'https://example.com/p', {
      env: ON, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(first).toMatchObject({ submitted: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://web.archive.org/save/https://example.com/p');
    expect(init.method).toBe('GET');

    const second = await maybeSubmitToSavePageNow(redis, 'https://example.com/p', {
      env: ON, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second).toEqual({ submitted: false, skipped: 'duplicate' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second network call
  });

  it('uses the authenticated SPN2 endpoint + parses job_id when an S3 key is set', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn(async () => res({ status: 200, json: { job_id: 'spn-abc' } }));
    const out = await maybeSubmitToSavePageNow(redis, 'https://example.com/q', {
      env: { WAYBACK_SPN_ENABLED: '1', WAYBACK_SPN_S3_KEY: 'access:secret' } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toMatchObject({ submitted: true, status: 200, jobId: 'spn-abc' });
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://web.archive.org/save');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('LOW access:secret');
    expect(String(init.body)).toContain('url=https');
  });

  it('never throws when the fetch fails', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const out = await maybeSubmitToSavePageNow(redis, 'https://example.com/p', {
      env: ON, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.submitted).toBe(false);
    expect(out.error).toContain('network down');
  });

  it('treats a 429 as not-submitted without throwing', async () => {
    const redis = fakeRedis();
    const fetchImpl = vi.fn(async () => res({ status: 429 }));
    const out = await maybeSubmitToSavePageNow(redis, 'https://example.com/p', {
      env: ON, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toMatchObject({ submitted: false, status: 429 });
  });
});
