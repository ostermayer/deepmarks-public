import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  MetadataStore,
  extractMetadata,
  isPlausibleLud16OrLnurl,
  normalizeTag,
  parseAllowedUrl,
  tagsFromString,
} from './metadata.js';

describe('parseAllowedUrl', () => {
  it('accepts plain https URL', () => {
    expect(parseAllowedUrl('https://example.com/foo')?.toString()).toBe('https://example.com/foo');
  });
  it('accepts http + path + query', () => {
    expect(parseAllowedUrl('http://example.com/a?b=1')?.toString()).toBe('http://example.com/a?b=1');
  });
  it('rejects non-http(s)', () => {
    expect(parseAllowedUrl('file:///etc/passwd')).toBeNull();
    expect(parseAllowedUrl('ftp://example.com')).toBeNull();
    expect(parseAllowedUrl('javascript:alert(1)')).toBeNull();
  });
  it('rejects IPv4 literal', () => {
    expect(parseAllowedUrl('http://10.0.0.1/')).toBeNull();
    expect(parseAllowedUrl('https://127.0.0.1')).toBeNull();
    expect(parseAllowedUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
  });
  it('rejects single-label host', () => {
    expect(parseAllowedUrl('http://localhost/')).toBeNull();
    expect(parseAllowedUrl('http://intranet/')).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseAllowedUrl('not a url')).toBeNull();
    expect(parseAllowedUrl('')).toBeNull();
    expect(parseAllowedUrl(null)).toBeNull();
    expect(parseAllowedUrl(undefined)).toBeNull();
  });
});

describe('normalizeTag', () => {
  it('lowercases', () => { expect(normalizeTag('React')).toBe('react'); });
  it('keeps hyphen + dot', () => {
    expect(normalizeTag('web-dev')).toBe('web-dev');
    expect(normalizeTag('node.js')).toBe('node.js');
  });
  it('takes only first word from multi-word input', () => {
    expect(normalizeTag('web development')).toBe('web');
  });
  it('strips leading/trailing punctuation', () => {
    expect(normalizeTag('.hidden')).toBe('hidden');
    expect(normalizeTag('trailing-')).toBe('trailing');
  });
  it('drops illegal chars', () => {
    expect(normalizeTag('c++')).toBe('c');
    expect(normalizeTag('#hashtag')).toBe('hashtag');
  });
  it('returns null for junk', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('!!!')).toBeNull();
  });
  it('rejects overlong tags', () => {
    expect(normalizeTag('a'.repeat(41))).toBeNull();
  });
});

describe('tagsFromString', () => {
  it('splits on commas', () => {
    expect(tagsFromString('react, nodejs, web')).toEqual(['react', 'nodejs', 'web']);
  });
  it('splits on pipes + semicolons', () => {
    expect(tagsFromString('a|b;c')).toEqual(['a', 'b', 'c']);
  });
  it('splits multi-word phrases into separate tags', () => {
    expect(tagsFromString('web development, machine learning'))
      .toEqual(['web', 'development', 'machine', 'learning']);
  });
  it('handles empty input', () => {
    expect(tagsFromString('')).toEqual([]);
    expect(tagsFromString(',,,')).toEqual([]);
  });
});

describe('extractMetadata', () => {
  it('pulls title from og:title first, falls back to <title>', () => {
    const html = `<html><head>
      <title>boring plain</title>
      <meta property="og:title" content="og wins"/>
    </head></html>`;
    expect(extractMetadata('https://example.com/', html).title).toBe('og wins');
  });
  it('falls back to twitter:title then <title>', () => {
    const tw = `<html><head>
      <title>plain</title>
      <meta name="twitter:title" content="tw wins"/>
    </head></html>`;
    expect(extractMetadata('https://example.com/', tw).title).toBe('tw wins');

    const plain = `<html><head><title>just this</title></head></html>`;
    expect(extractMetadata('https://example.com/', plain).title).toBe('just this');
  });
  it('collapses whitespace in title', () => {
    const html = `<html><head><title>
      spaced     out
      title
    </title></head></html>`;
    expect(extractMetadata('https://example.com/', html).title).toBe('spaced out title');
  });
  it('extracts description from meta + og + twitter', () => {
    const og = `<html><head><meta property="og:description" content="og desc"/><meta name="description" content="plain desc"/></head></html>`;
    expect(extractMetadata('https://example.com/', og).description).toBe('og desc');

    const plain = `<html><head><meta name="description" content="just plain"/></head></html>`;
    expect(extractMetadata('https://example.com/', plain).description).toBe('just plain');
  });
  it('resolves relative og:image against base URL', () => {
    const html = `<html><head><meta property="og:image" content="/banner.jpg"/></head></html>`;
    expect(extractMetadata('https://example.com/blog/post', html).image)
      .toBe('https://example.com/banner.jpg');
  });
  it('picks largest declared favicon', () => {
    const html = `<html><head>
      <link rel="icon" sizes="16x16" href="/small.png"/>
      <link rel="icon" sizes="64x64" href="/big.png"/>
    </head></html>`;
    expect(extractMetadata('https://example.com/', html).favicon)
      .toBe('https://example.com/big.png');
  });
  it('collects keywords + article:tag + news_keywords as suggested tags', () => {
    const html = `<html><head>
      <meta name="keywords" content="react, nodejs, web development"/>
      <meta property="article:tag" content="Javascript"/>
      <meta name="news_keywords" content="Open Source"/>
    </head></html>`;
    const meta = extractMetadata('https://example.com/', html);
    expect(meta.suggestedTags).toEqual(['react', 'nodejs', 'web', 'development', 'open', 'source', 'javascript']);
  });
  it('dedupes overlapping keyword sources', () => {
    const html = `<html><head>
      <meta name="keywords" content="react, react"/>
      <meta property="article:tag" content="react"/>
    </head></html>`;
    expect(extractMetadata('https://example.com/', html).suggestedTags).toEqual(['react']);
  });
  it('caps suggested tags at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`).join(',');
    const html = `<html><head><meta name="keywords" content="${many}"/></head></html>`;
    expect(extractMetadata('https://example.com/', html).suggestedTags).toHaveLength(8);
  });
  it('extracts lightning address from meta tag', () => {
    const html = `<html><head><meta name="lightning" content="tips@example.com"/></head></html>`;
    expect(extractMetadata('https://example.com/', html).lightning).toBe('tips@example.com');
  });
  it('extracts lightning from <link rel="lightning">', () => {
    const html = `<html><head><link rel="lightning" href="lightning:me@wallet.com"/></head></html>`;
    expect(extractMetadata('https://example.com/', html).lightning).toBe('me@wallet.com');
  });
  it('rejects non-lud16 / non-LNURL lightning values (attacker-controlled pages)', () => {
    // A malicious page can inject any string — we must not route an
    // attacker-chosen "site operator" leg into the zap split.
    const htmls = [
      `<html><head><meta name="lightning" content="not-an-address"/></head></html>`,
      `<html><head><meta name="lightning" content="  "/></head></html>`,
      `<html><head><meta name="lightning" content="javascript:alert(1)"/></head></html>`,
      `<html><head><meta name="lightning" content="${'a'.repeat(250)}@evil.com"/></head></html>`,
    ];
    for (const html of htmls) {
      expect(extractMetadata('https://example.com/', html).lightning).toBeUndefined();
    }
  });
  it('returns mostly-empty result for a blank page', () => {
    const meta = extractMetadata('https://example.com/', '<html></html>');
    expect(meta.url).toBe('https://example.com/');
    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.image).toBeUndefined();
    expect(meta.favicon).toBeUndefined();
    expect(meta.lightning).toBeUndefined();
    expect(meta.suggestedTags).toEqual([]);
  });
});

describe('isPlausibleLud16OrLnurl', () => {
  it('accepts standard lud16 addresses', () => {
    expect(isPlausibleLud16OrLnurl('tips@example.com')).toBe(true);
    expect(isPlausibleLud16OrLnurl('user.name@getalby.com')).toBe(true);
    expect(isPlausibleLud16OrLnurl('a+b@wallet.io')).toBe(true);
  });
  it('accepts bech32 LNURLs', () => {
    // bech32 alphabet excludes 1, b, i, o — so build a 50+ char payload
    // only from the allowed set.
    const payload = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2);
    expect(isPlausibleLud16OrLnurl(`lnurl1${payload}`)).toBe(true);
  });
  it('rejects empty / whitespace / garbage', () => {
    expect(isPlausibleLud16OrLnurl('')).toBe(false);
    expect(isPlausibleLud16OrLnurl('   ')).toBe(false);
    expect(isPlausibleLud16OrLnurl('not-an-address')).toBe(false);
    expect(isPlausibleLud16OrLnurl('javascript:alert(1)')).toBe(false);
    expect(isPlausibleLud16OrLnurl('http://evil.com')).toBe(false);
  });
  it('rejects unreasonably long strings (denial-of-zap)', () => {
    expect(isPlausibleLud16OrLnurl('a'.repeat(300) + '@b.com')).toBe(false);
  });
});

describe('MetadataStore.rateLimitCheck', () => {
  /** Minimal Redis stub — only the surface rateLimitCheck touches. */
  class RlFake {
    counts = new Map<string, number>();
    ttl_ = new Map<string, number>();
    async incr(k: string) {
      const n = (this.counts.get(k) ?? 0) + 1;
      this.counts.set(k, n);
      return n;
    }
    async expire(k: string, s: number) {
      this.ttl_.set(k, s);
      return 1;
    }
    async ttl(k: string) {
      return this.ttl_.get(k) ?? -2;
    }
  }

  it('lets callers through under the limit, rejects past it', async () => {
    const store = new MetadataStore(new RlFake() as unknown as Redis);
    // 3/min just for the test
    for (let i = 0; i < 3; i++) {
      const r = await store.rateLimitCheck('1.2.3.4', 3, 60);
      expect(r.ok).toBe(true);
    }
    const r = await store.rateLimitCheck('1.2.3.4', 3, 60);
    expect(r).toEqual({ ok: false, retryAfter: 60 });
  });

  it('buckets per IP — one noisy client doesn\'t block another', async () => {
    const store = new MetadataStore(new RlFake() as unknown as Redis);
    for (let i = 0; i < 3; i++) await store.rateLimitCheck('1.2.3.4', 3, 60);
    const r = await store.rateLimitCheck('5.6.7.8', 3, 60);
    expect(r.ok).toBe(true);
  });

  it('degrades open when Redis is not configured (dev mode)', async () => {
    const store = new MetadataStore(null);
    const r = await store.rateLimitCheck('1.2.3.4', 1, 60);
    expect(r).toEqual({ ok: true });
  });
});
