import { describe, expect, it } from 'vitest';
import { residentialSourceIp, residentialSourceIpFor } from '../../archive-worker/src/residential-egress.js';

const OFF = {} as NodeJS.ProcessEnv;
const ON = { RESIDENTIAL_EGRESS_SOURCE_IP: '10.66.0.2' } as NodeJS.ProcessEnv;

describe('residential egress selection (last-ditch fallback)', () => {
  it('residentialSourceIp is the configured wg0 IP, or undefined when off', () => {
    expect(residentialSourceIp(OFF)).toBeUndefined();
    expect(residentialSourceIp({ RESIDENTIAL_EGRESS_SOURCE_IP: '  ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(residentialSourceIp(ON)).toBe('10.66.0.2');
  });

  it('by default routes NOTHING residential up front — not even youtube', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://example.com/p',
    ]) {
      expect(residentialSourceIpFor(url, {}, ON)).toBeUndefined();
    }
  });

  it('routes a fallback retry residential regardless of host', () => {
    expect(residentialSourceIpFor('https://www.youtube.com/watch?v=abc', { fallback: true }, ON)).toBe('10.66.0.2');
    expect(residentialSourceIpFor('https://example.com/p', { fallback: true }, ON)).toBe('10.66.0.2');
    expect(residentialSourceIpFor('https://example.com/p', { fallback: true }, OFF)).toBeUndefined(); // off
  });

  it('honours an optional RESIDENTIAL_ALWAYS_DOMAINS override (first-try residential)', () => {
    const env = {
      RESIDENTIAL_EGRESS_SOURCE_IP: '10.66.0.2',
      RESIDENTIAL_ALWAYS_DOMAINS: 'kaggle.com, vimeo.com',
    } as NodeJS.ProcessEnv;
    expect(residentialSourceIpFor('https://www.kaggle.com/x', {}, env)).toBe('10.66.0.2');
    expect(residentialSourceIpFor('https://vimeo.com/1', {}, env)).toBe('10.66.0.2');
    expect(residentialSourceIpFor('https://youtube.com/w', {}, env)).toBeUndefined(); // not listed
  });

  it('ignores unparseable URLs on the non-fallback path, but fallback still routes', () => {
    expect(residentialSourceIpFor('not a url', {}, ON)).toBeUndefined();
    expect(residentialSourceIpFor('not a url', { fallback: true }, ON)).toBe('10.66.0.2');
  });
});
