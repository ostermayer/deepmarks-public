import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { promises as dns } from 'node:dns';
import {
  MetadataStore,
  crossrefMetadataFromResponse,
  extractDoiFromUrl,
  extractMetadata,
  isPlausibleLud16OrLnurl,
  mediaKindFromContentType,
  metadataFromMediaContentType,
  metadataFromOembed,
  normalizeTag,
  parseAllowedUrl,
  tagsFromString,
  youtubeMetadataFromOembed,
} from '@src/metadata.js';

vi.mock('node:dns', () => ({
  promises: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
  },
}));

const dnsLookupMock = dns.lookup as unknown as {
  mockReset: () => void;
  mockResolvedValue: (value: Array<{ address: string; family: number }>) => void;
  mockResolvedValueOnce: (value: Array<{ address: string; family: number }>) => unknown;
};

const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];

afterEach(() => {
  vi.unstubAllGlobals();
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue(PUBLIC_DNS);
});

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
    expect(parseAllowedUrl('http://box-a.local/')).toBeNull();
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
  it('falls back to schema.org JSON-LD for title, description, and image', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Article",
          "headline": "Structured headline",
          "description": "Structured description",
          "image": { "url": "/structured.jpg" }
        }
      </script>
    </head></html>`;
    expect(extractMetadata('https://example.com/post', html)).toMatchObject({
      title: 'Structured headline',
      description: 'Structured description',
      image: 'https://example.com/structured.jpg',
    });
  });
  it('falls back to itemprop metadata before plain title/body text', () => {
    const html = `<html><head>
      <meta itemprop="headline" content="Item headline" />
      <meta itemprop="description" content="Item description" />
      <meta itemprop="image" content="/item.jpg" />
      <title>Plain title</title>
    </head></html>`;
    expect(extractMetadata('https://example.com/post', html)).toMatchObject({
      title: 'Item headline',
      description: 'Item description',
      image: 'https://example.com/item.jpg',
    });
  });
  it('uses the first substantial article paragraph when meta descriptions are absent', () => {
    const html = `<html><head><title>Plain title</title></head><body>
      <article>
        <p>Short.</p>
        <p>This paragraph has enough real article text to work as a useful preview description when the page does not publish Open Graph or meta description fields.</p>
      </article>
    </body></html>`;
    expect(extractMetadata('https://example.com/post', html).description)
      .toBe('This paragraph has enough real article text to work as a useful preview description when the page does not publish Open Graph or meta description fields.');
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
  it('extracts full-text PDF URLs from scholarly page metadata', () => {
    const html = `<html><head>
      <meta name="citation_pdf_url" content="/article-pdf/10.1000/test.pdf" />
    </head></html>`;
    expect(extractMetadata('https://journal.example.org/article/10.1000/test', html).pdfUrl)
      .toBe('https://journal.example.org/article-pdf/10.1000/test.pdf');
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

  it('builds lightweight YouTube previews from oEmbed data', () => {
    const meta = youtubeMetadataFromOembed('https://www.youtube.com/watch?v=EBttg4yUE2s', {
      title: 'Home mining guide',
      author_name: 'jack mallers',
      thumbnail_url: 'https://i.ytimg.com/vi/EBttg4yUE2s/hqdefault.jpg',
    });

    expect(meta).toMatchObject({
      url: 'https://www.youtube.com/watch?v=EBttg4yUE2s',
      title: 'Home mining guide',
      description: 'YouTube video by jack mallers',
      image: 'https://i.ytimg.com/vi/EBttg4yUE2s/hqdefault.jpg',
      suggestedTags: [],
    });
  });

  it('normalizes generic oEmbed data without marking hosted pages as direct media', () => {
    const meta = metadataFromOembed('https://vimeo.com/123', {
      title: 'Vimeo title',
      author_name: 'Film maker',
      provider_name: 'Vimeo',
      thumbnail_url: 'https://i.vimeocdn.com/video/123.jpg',
      type: 'video',
    });

    expect(meta).toEqual({
      url: 'https://vimeo.com/123',
      title: 'Vimeo title',
      description: 'Vimeo by Film maker',
      image: 'https://i.vimeocdn.com/video/123.jpg',
      suggestedTags: [],
    });
  });

  it('fills missing hosted-video previews from a page-advertised oEmbed endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(`<html><head>
        <link rel="alternate" type="application/json+oembed" href="https://player.example.com/oembed?url=https%3A%2F%2Fvideo.example.com%2Fwatch%2F1" />
      </head></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: 'Hosted video',
        provider_name: 'Example Video',
        author_name: 'Example Creator',
        thumbnail_url: 'https://cdn.example.com/thumb.jpg',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const meta = await new MetadataStore(null).resolve('https://video.example.com/watch/1');

    expect(meta).toMatchObject({
      url: 'https://video.example.com/watch/1',
      title: 'Hosted video',
      description: 'Example Video by Example Creator',
      image: 'https://cdn.example.com/thumb.jpg',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch preview URLs whose host resolves to a private address', async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: '10.0.0.4', family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const meta = await new MetadataStore(null).resolve('https://preview.example.com/article');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(meta).toEqual({
      url: 'https://preview.example.com/article',
      suggestedTags: [],
    });
  });

  it('does not fetch page-advertised oEmbed endpoints whose host resolves private', async () => {
    dnsLookupMock
      .mockResolvedValueOnce(PUBLIC_DNS)
      .mockResolvedValueOnce([{ address: '172.16.0.2', family: 4 }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(`<html><head>
        <title>Host page title</title>
        <link rel="alternate" type="application/json+oembed" href="https://oembed.example.net/private" />
      </head></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const meta = await new MetadataStore(null).resolve('https://video.example.com/watch/1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meta).toMatchObject({
      url: 'https://video.example.com/watch/1',
      title: 'Host page title',
    });
  });
});

describe('Crossref metadata fallback', () => {
  it('extracts Oxford-style DOI URLs without the publisher-local article id', () => {
    expect(extractDoiFromUrl('https://academic.oup.com/bioscience/advance-article/doi/10.1093/biosci/biaf050/8116758'))
      .toBe('10.1093/biosci/biaf050');
  });

  it('normalizes DOI resolver URLs', () => {
    expect(extractDoiFromUrl('https://doi.org/10.1000/ABC.Def')).toBe('10.1000/abc.def');
  });

  it('builds metadata from a Crossref work response', () => {
    const meta = crossrefMetadataFromResponse('https://doi.org/10.1093/biosci/biaf050', '10.1093/biosci/biaf050', {
      message: {
        title: ['Where is the elusive primary <i>ebolavirus</i> reservoir and how do we find It?'],
        abstract: '<jats:p>Identifying the reservoir remains an important scientific problem.</jats:p>',
        subject: ['Medicine', 'Virology'],
        type: 'journal-article',
        published: { 'date-parts': [[2026, 5, 15]] },
      },
    });

    expect(meta).toEqual({
      url: 'https://doi.org/10.1093/biosci/biaf050',
      title: 'Where is the elusive primary ebolavirus reservoir and how do we find It?',
      description: 'Identifying the reservoir remains an important scientific problem.',
      suggestedTags: ['scholarly', 'medicine', 'virology', 'journal-article'],
    });
  });

  it('uses Crossref when a blocked DOI URL has no bookmark fallback metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: {
          title: ['Blocked scholarly page'],
          subject: ['Biology'],
          type: 'journal-article',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const meta = await new MetadataStore(null).resolve('https://academic.example.org/article/doi/10.1234/foo/bar/999');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meta).toMatchObject({
      title: 'Blocked scholarly page',
      suggestedTags: ['scholarly', 'biology', 'journal-article'],
    });
  });
});

describe('direct media metadata', () => {
  it('classifies common media content types', () => {
    expect(mediaKindFromContentType('video/mp4; charset=binary')).toBe('video');
    expect(mediaKindFromContentType('image/webp')).toBe('image');
    expect(mediaKindFromContentType('audio/mpeg')).toBe('audio');
    expect(mediaKindFromContentType('application/octet-stream')).toBeNull();
  });

  it('returns a playable metadata stub for extensionless media URLs', () => {
    expect(metadataFromMediaContentType(
      'https://blossom.primal.net/5605dcac7b8fde7e003959fb221791f6dff0dc424e581894d6c4443a8f18b502',
      'video/mp4',
    )).toEqual({
      url: 'https://blossom.primal.net/5605dcac7b8fde7e003959fb221791f6dff0dc424e581894d6c4443a8f18b502',
      title: 'video from blossom.primal.net',
      mediaKind: 'video',
      contentType: 'video/mp4',
      suggestedTags: [],
    });
  });

  it('uses the URL itself as the preview image for direct images', () => {
    expect(metadataFromMediaContentType('https://blossom.band/hash', 'image/jpeg')).toMatchObject({
      image: 'https://blossom.band/hash',
      mediaKind: 'image',
    });
  });

  it('resolves direct media responses without HTML metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('not actually read', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    ));

    const url = 'https://blossom.primal.net/5605dcac7b8fde7e003959fb221791f6dff0dc424e581894d6c4443a8f18b502';
    const meta = await new MetadataStore(null).resolve(url);

    expect(meta).toMatchObject({
      url,
      title: 'video from blossom.primal.net',
      mediaKind: 'video',
      contentType: 'video/mp4',
      suggestedTags: [],
    });
  });

  it('uses a bookmark metadata fallback when a site blocks preview fetching', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('blocked', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      }),
    ));
    const url = 'https://academic.example.org/article/10.1000/test';
    const fallback = vi.fn().mockResolvedValue({
      url,
      title: 'Previously bookmarked paper',
      description: 'Metadata from an existing Nostr bookmark.',
      suggestedTags: ['research', 'biology'],
    });

    const meta = await new MetadataStore(null, fallback).resolve(url);

    expect(fallback).toHaveBeenCalledWith(url);
    expect(meta).toEqual({
      url,
      title: 'Previously bookmarked paper',
      description: 'Metadata from an existing Nostr bookmark.',
      suggestedTags: ['research', 'biology'],
    });
  });

  it('can replace an old empty metadata cache entry with bookmark fallback metadata', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://academic.example.org/article/10.1000/cached';
    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ url, suggestedTags: [] })),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;
    const fallback = vi.fn().mockResolvedValue({
      url,
      title: 'Cached fallback paper',
      suggestedTags: ['research'],
    });

    const meta = await new MetadataStore(redis, fallback).resolve(url);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(url);
    expect(meta).toMatchObject({ title: 'Cached fallback paper', suggestedTags: ['research'] });
    expect(redis.set).toHaveBeenCalled();
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
