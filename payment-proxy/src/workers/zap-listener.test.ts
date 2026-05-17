import { describe, it, expect } from 'vitest';
import { decodeBolt11Amount } from './zap-listener.js';

// Unit tests pinning the BOLT-11 multiplier table. The function uses
// magic literals (1e8, 1e5, 1e2, 1/10, 1e11) that are easy to typo
// in a refactor — these tests catch any drift.

describe('decodeBolt11Amount', () => {
  // BOLT-11 amount uses bitcoin-amount-with-multiplier format. Examples:
  //   1m → 1 milli-BTC = 100_000_000 msat
  //   1u → 1 micro-BTC = 100_000 msat
  //   1n → 1 nano-BTC  = 100 msat
  //   10p → 10 pico-BTC = 1 msat (10/10)
  //   1 (no multiplier) → 1 BTC = 100_000_000_000 msat
  it('decodes milli-BTC (m) → msats', () => {
    expect(decodeBolt11Amount('lnbc1m1abc')).toBe(1e8);
    expect(decodeBolt11Amount('lnbc21m1abc')).toBe(21 * 1e8);
  });

  it('decodes micro-BTC (u) → msats', () => {
    expect(decodeBolt11Amount('lnbc1u1abc')).toBe(1e5);
    expect(decodeBolt11Amount('lnbc100u1abc')).toBe(100 * 1e5);
  });

  it('decodes nano-BTC (n) → msats', () => {
    expect(decodeBolt11Amount('lnbc1n1abc')).toBe(100);
    expect(decodeBolt11Amount('lnbc1000n1abc')).toBe(100_000); // = 1u
  });

  it('decodes pico-BTC (p) → msats with /10 rounding', () => {
    expect(decodeBolt11Amount('lnbc10p1abc')).toBe(1);
    expect(decodeBolt11Amount('lnbc100p1abc')).toBe(10);
  });

  it('decodes plain BTC (no multiplier) → msats', () => {
    expect(decodeBolt11Amount('lnbc11abc')).toBe(1e11);
  });

  it('handles testnet (lntb) and regtest (lnbcrt) prefixes', () => {
    expect(decodeBolt11Amount('lntb21m1xyz')).toBe(21 * 1e8);
    expect(decodeBolt11Amount('lnbcrt1u1xyz')).toBe(1e5);
  });

  it('returns null for malformed input', () => {
    expect(decodeBolt11Amount('not-an-invoice')).toBeNull();
    expect(decodeBolt11Amount('lnbcz1abc')).toBeNull();   // 'z' isn't digits
    expect(decodeBolt11Amount('lnbc1x1abc')).toBeNull();  // 'x' isn't a multiplier
  });
});
