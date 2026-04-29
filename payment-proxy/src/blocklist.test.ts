import { describe, it, expect } from 'vitest';
import { normalizeUrl } from './blocklist.js';

describe('normalizeUrl', () => {
  it('lowercases the whole URL', () => {
    expect(normalizeUrl('HTTPS://EXAMPLE.COM/Foo')).toBe('https://example.com/foo');
  });

  it('strips trailing slashes', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/foo/')).toBe('https://example.com/foo');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/foo#section')).toBe('https://example.com/foo');
  });

  it('strips well-known tracking params', () => {
    const out = normalizeUrl(
      'https://example.com/x?utm_source=tw&fbclid=abc&keep=true&gclid=xyz'
    );
    expect(out).not.toContain('utm_source');
    expect(out).not.toContain('fbclid');
    expect(out).not.toContain('gclid');
    expect(out).toContain('keep=true');
  });

  it('treats two URLs identical after stripping trackers', () => {
    const a = normalizeUrl('https://example.com/x?utm_source=tw');
    const b = normalizeUrl('https://example.com/x');
    expect(a).toBe(b);
  });

  it('falls back to a trimmed lowercase string for malformed input', () => {
    expect(normalizeUrl('  not a url  ')).toBe('not a url');
  });
});
