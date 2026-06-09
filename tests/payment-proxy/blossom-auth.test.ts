import { describe, it, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { verifyBlossomAuthHeader } from '@src/routes/blossom-auth.js';

function authHeader(
  sk = generateSecretKey(),
  opts: { action?: string; expiration?: number; server?: string } = {},
): string {
  const now = 1_700_000_000;
  const pubkey = getPublicKey(sk);
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ['t', opts.action ?? 'upload'],
        ['x', 'f'.repeat(64)],
        ['expiration', String(opts.expiration ?? now + 60)],
        ['server', opts.server ?? 'https://blossom.deepmarks.org'],
      ],
      content: 'test blossom auth',
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

describe('verifyBlossomAuthHeader', () => {
  it('accepts a short-lived signed BUD-01 upload auth event', () => {
    const result = verifyBlossomAuthHeader(authHeader(), {
      method: 'PUT',
      serverUrl: 'https://blossom.deepmarks.org',
      now: 1_700_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects expired or overly long-lived auth events', () => {
    expect(verifyBlossomAuthHeader(authHeader(undefined, { expiration: 1_699_999_999 }), {
      method: 'PUT',
      now: 1_700_000_000,
    }).ok).toBe(false);
    expect(verifyBlossomAuthHeader(authHeader(undefined, { expiration: 1_700_001_000 }), {
      method: 'PUT',
      now: 1_700_000_000,
    }).ok).toBe(false);
  });

  it('rejects action/method mismatches and wrong server bindings', () => {
    expect(verifyBlossomAuthHeader(authHeader(undefined, { action: 'upload' }), {
      method: 'DELETE',
      now: 1_700_000_000,
    }).ok).toBe(false);
    expect(verifyBlossomAuthHeader(authHeader(undefined, { server: 'https://other.example' }), {
      method: 'PUT',
      serverUrl: 'https://blossom.deepmarks.org',
      now: 1_700_000_000,
    }).ok).toBe(false);
  });
});
