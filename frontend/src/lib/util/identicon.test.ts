import { describe, it, expect } from 'vitest';
import { colorFromPubkey, initialFor } from './identicon.js';

describe('colorFromPubkey', () => {
  it('is deterministic — same input always returns the same color', () => {
    const k = '463557b6b687803f4ddbeb98a3eafeaf7e5e31cd27419802a4d289c4935c2843';
    expect(colorFromPubkey(k)).toBe(colorFromPubkey(k));
  });

  it('produces a valid HSL string', () => {
    expect(colorFromPubkey('00aaff')).toMatch(/^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/);
  });

  it('hue varies with the first byte', () => {
    const a = colorFromPubkey('00deadbeef');
    const b = colorFromPubkey('80deadbeef');
    expect(a).not.toBe(b);
  });

  it('falls back to a sane default on garbage input rather than throwing', () => {
    expect(() => colorFromPubkey('')).not.toThrow();
    expect(colorFromPubkey('')).toMatch(/^hsl\(/);
    expect(colorFromPubkey('xyz')).toMatch(/^hsl\(/);
  });

  it('keeps lightness in a legible band (40-55%) so white text always reads', () => {
    for (const seed of ['00', 'ff', '7a', 'a3', 'b9']) {
      const m = /^hsl\(\d+ \d+% (\d+)%\)$/.exec(colorFromPubkey(seed + 'deadbeef'));
      const lightness = Number(m?.[1]);
      expect(lightness).toBeGreaterThanOrEqual(40);
      expect(lightness).toBeLessThanOrEqual(55);
    }
  });
});

describe('initialFor', () => {
  it('uses the first letter of the display name', () => {
    expect(initialFor('Alice', 'npub1xyz')).toBe('A');
  });
  it('uppercases lowercase names', () => {
    expect(initialFor('bob', undefined)).toBe('B');
  });
  it('falls back to the first npub character past the npub1 prefix', () => {
    expect(initialFor(undefined, 'npub1gc64tw6tp7q06ymkltnz374l4al9uvwdyaqasz4y6gjujf4u9plqz2uyek')).toBe('G');
  });
  it('returns "?" when both inputs are empty', () => {
    expect(initialFor(undefined, undefined)).toBe('?');
    expect(initialFor('', '')).toBe('?');
  });
  it('skips whitespace-only display names', () => {
    expect(initialFor('   ', 'npub1abc')).toBe('A');
  });
  it('handles a non-npub string by falling back to ?', () => {
    expect(initialFor(undefined, 'pub1xyz')).toBe('?');
  });
});
