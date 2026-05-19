import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  buildLud06Metadata,
  buildLnurlpResponse,
  descriptionHashHex,
  buildCallbackResponse,
  lnurlError
} from './lnurl.js';

describe('buildLud06Metadata', () => {
  it('returns a stringified array of [type, value] pairs', () => {
    const meta = buildLud06Metadata('zap@deepmarks.org');
    const parsed = JSON.parse(meta) as [string, string][];
    expect(parsed.find((p) => p[0] === 'text/identifier')?.[1]).toBe('zap@deepmarks.org');
    expect(parsed.find((p) => p[0] === 'text/plain')).toBeDefined();
  });
});

describe('buildLnurlpResponse', () => {
  it('declares NIP-57 zap support and includes the receipt-signing pubkey', () => {
    const out = buildLnurlpResponse({
      callbackUrl: 'https://x/callback',
      lnAddress: 'zap@deepmarks.org',
      nostrPubkey: 'a'.repeat(64)
    });
    expect(out.tag).toBe('payRequest');
    expect(out.allowsNostr).toBe(true);
    expect(out.nostrPubkey).toBe('a'.repeat(64));
    expect(out.commentAllowed).toBe(280);
  });

  it('uses sensible default sendable bounds', () => {
    const out = buildLnurlpResponse({
      callbackUrl: 'https://x/c',
      lnAddress: 'a@b',
      nostrPubkey: 'b'.repeat(64)
    });
    expect(out.minSendable).toBe(1_000); // 1 sat
    expect(out.maxSendable).toBe(1_000_000_000); // 1M sats — capped for HTLC-slot DoS protection
  });
});

describe('descriptionHashHex — CLAUDE.md MUST-rule', () => {
  // The receipt's description_hash MUST be SHA-256 of the EXACT raw JSON
  // string of the zap request. Re-serializing first will mismatch.
  it('hashes the exact bytes of the input string', () => {
    const input = '{"kind":9734,"content":"","tags":[]}';
    const expected = bytesToHex(sha256(new TextEncoder().encode(input)));
    expect(descriptionHashHex(input)).toBe(expected);
  });

  it('produces different hashes for whitespace differences', () => {
    const a = descriptionHashHex('{"kind":9734}');
    const b = descriptionHashHex('{ "kind": 9734 }');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for key reordering', () => {
    // Same logical content, different key order — hash must differ.
    const a = descriptionHashHex('{"a":1,"b":2}');
    const b = descriptionHashHex('{"b":2,"a":1}');
    expect(a).not.toBe(b);
  });

  it('returns 64 hex chars (256 bits)', () => {
    expect(descriptionHashHex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildCallbackResponse', () => {
  it('matches LUD-06 shape', () => {
    expect(buildCallbackResponse('lnbc1...')).toEqual({ pr: 'lnbc1...', routes: [] });
  });
});

describe('lnurlError', () => {
  it('returns the LUD-06 error envelope', () => {
    expect(lnurlError('amount too low')).toEqual({ status: 'ERROR', reason: 'amount too low' });
  });
});
