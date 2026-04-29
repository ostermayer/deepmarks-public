import { describe, it, expect } from 'vitest';
import { buildAtomFeed, xmlEscape, type FeedMeta } from './atom.js';
import type { BookmarkJson } from '../api-helpers.js';

const META: FeedMeta = {
  title: 'Deepmarks · Recent',
  htmlUrl: 'https://deepmarks.org/app/recent',
  feedUrl: 'https://deepmarks.org/feed/recent.xml',
  id: 'https://deepmarks.org/feed/recent',
  subtitle: 'The newest public bookmarks across the network.',
};

function bm(overrides: Partial<BookmarkJson> = {}): BookmarkJson {
  return {
    id: 'a'.repeat(64),
    pubkey: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2',
    url: 'https://example.com/article',
    title: 'An article',
    description: 'A short description',
    tags: ['bitcoin', 'lightning'],
    archivedForever: false,
    savedAt: 1_700_000_000,
    ...overrides,
  };
}

describe('xmlEscape', () => {
  it('escapes the five mandatory character refs', () => {
    expect(xmlEscape('<a href="x">Tom & Jerry\'s</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;',
    );
  });
  it('strips illegal control chars but preserves tab/LF/CR', () => {
    const input = 'hello\x00world\x01\tline\r\nnext';
    expect(xmlEscape(input)).toBe('helloworld\tline\r\nnext');
  });
  it('preserves multi-byte UTF-8 unchanged', () => {
    expect(xmlEscape('café 🌍')).toBe('café 🌍');
  });
});

describe('buildAtomFeed', () => {
  it('declares UTF-8 XML + Atom namespace + feed metadata', () => {
    const xml = buildAtomFeed(META, []);
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<title>Deepmarks · Recent</title>');
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://deepmarks.org/feed/recent.xml"/>',
    );
    expect(xml).toContain('<id>https://deepmarks.org/feed/recent</id>');
  });

  it('uses the freshest entry\'s savedAt as the feed-level <updated>', () => {
    const xml = buildAtomFeed(META, [
      bm({ savedAt: 1_700_000_000 }),
      bm({ savedAt: 1_700_001_000 }),
      bm({ savedAt: 1_699_999_000 }),
    ]);
    expect(xml).toContain(`<updated>${new Date(1_700_001_000 * 1000).toISOString()}</updated>`);
  });

  it('renders each bookmark as a well-formed <entry>', () => {
    const xml = buildAtomFeed(META, [bm()]);
    expect(xml).toContain('<entry>');
    expect(xml).toContain('<title>An article</title>');
    expect(xml).toContain('<link href="https://example.com/article"/>');
    expect(xml).toMatch(/<id>nostr:[0-9a-f]{64}<\/id>/);
    expect(xml).toContain('<summary>A short description</summary>');
    expect(xml).toContain('<category term="bitcoin"/>');
    expect(xml).toContain('<category term="lightning"/>');
  });

  it('encodes the author as npub inside <author><name>', () => {
    const xml = buildAtomFeed(META, [bm()]);
    expect(xml).toMatch(/<name>npub1[a-z0-9]+<\/name>/);
  });

  it('includes the archived-forever category when set', () => {
    const xml = buildAtomFeed(META, [bm({ archivedForever: true })]);
    expect(xml).toContain('<category term="archived-forever" label="archived forever"/>');
  });

  it('omits <summary> when the bookmark has no description', () => {
    const xml = buildAtomFeed(META, [bm({ description: '' })]);
    expect(xml).not.toContain('<summary>');
  });

  it('escapes URL and title special characters', () => {
    const xml = buildAtomFeed(META, [
      bm({
        title: 'Tom & Jerry\'s "hot" take',
        url: 'https://x.test/path?a=1&b=<2>',
      }),
    ]);
    expect(xml).toContain('Tom &amp; Jerry&apos;s &quot;hot&quot; take');
    expect(xml).toContain('a=1&amp;b=&lt;2&gt;');
  });

  it('falls back title → url when title is empty (avoids an empty <title>)', () => {
    const xml = buildAtomFeed(META, [bm({ title: '', url: 'https://fallback.test' })]);
    expect(xml).toContain('<title>https://fallback.test</title>');
  });

  it('returns a valid empty feed when bookmarks list is empty', () => {
    const xml = buildAtomFeed(META, []);
    expect(xml).toContain('<feed');
    expect(xml).toContain('</feed>');
    expect(xml).not.toContain('<entry>');
  });
});
