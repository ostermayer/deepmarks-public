import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { verifyNip98 } from '@src/auth.js';

describe('verifyNip98', () => {
  function makeAuthHeader(opts: {
    url: string;
    method: string;
    skewSeconds?: number;
    kind?: number;
  }): string {
    const sk = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: opts.kind ?? 27235,
        created_at: Math.floor(Date.now() / 1000) + (opts.skewSeconds ?? 0),
        content: '',
        tags: [
          ['u', opts.url],
          ['method', opts.method]
        ]
      },
      sk
    );
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
  }

  it('accepts a fresh, well-signed auth event with matching url+method', async () => {
    const header = makeAuthHeader({ url: 'https://x/api', method: 'POST' });
    const r = await verifyNip98(header, 'https://x/api', 'POST');
    expect(r.ok).toBe(true);
    expect(r.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects when header is missing', async () => {
    const r = await verifyNip98(undefined, 'https://x/api', 'POST');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing/i);
  });

  it('rejects when scheme is not Nostr', async () => {
    const r = await verifyNip98('Bearer abc', 'https://x', 'GET');
    expect(r.ok).toBe(false);
  });

  it('rejects an event of the wrong kind', async () => {
    const header = makeAuthHeader({ url: 'https://x', method: 'GET', kind: 1 });
    const r = await verifyNip98(header, 'https://x', 'GET');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/kind/);
  });

  it('rejects an event older than 60s of skew', async () => {
    const header = makeAuthHeader({ url: 'https://x', method: 'GET', skewSeconds: -120 });
    const r = await verifyNip98(header, 'https://x', 'GET');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/stale|skew|future/i);
  });

  it('rejects when u tag does not match request URL', async () => {
    const header = makeAuthHeader({ url: 'https://x', method: 'POST' });
    const r = await verifyNip98(header, 'https://other', 'POST');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/u tag/);
  });

  it('rejects when method tag disagrees with the request method', async () => {
    const header = makeAuthHeader({ url: 'https://x', method: 'GET' });
    const r = await verifyNip98(header, 'https://x', 'POST');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/method/);
  });

  it('matches methods case-insensitively', async () => {
    const header = makeAuthHeader({ url: 'https://x', method: 'post' });
    const r = await verifyNip98(header, 'https://x', 'POST');
    expect(r.ok).toBe(true);
  });
});
