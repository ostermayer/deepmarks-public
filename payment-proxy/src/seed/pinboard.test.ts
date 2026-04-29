import { describe, it, expect } from 'vitest';
import {
  canonicalizeUrl,
  dedupe,
  parsePinboardPage,
  shuffle,
  type PinboardEntry,
} from './pinboard.js';

// Realistic-shape fixture mirroring how Pinboard renders its popular page.
const FIXTURE = `
<!DOCTYPE html>
<html><body>
<div id="popular_bookmarks">

  <div class="bookmark" id="bm-1">
    <a class="bookmark_title" href="https://example.com/article-one">First article</a>
    <div class="description">A short blurb about the first article.</div>
    <div class="bookmark_details">
      by <a class="user" href="/u:alice">alice</a>
      on <a class="when" href="/u:alice/2026-04-21">just now</a>
      to <a class="tag" href="/t:bitcoin">bitcoin</a>
      <a class="tag" href="/t:lightning">lightning</a>
    </div>
  </div>

  <div class="bookmark" id="bm-2">
    <a class="bookmark_title" href="https://example.com/article-two?utm_source=twitter&utm_medium=social#section">Second article</a>
    <div class="bookmark_details">
      to <a class="tag" href="/t:rust">RUST</a>
      <a class="tag" href="/t:async">async</a>
    </div>
  </div>

  <!-- Broken entry: no title text -->
  <div class="bookmark" id="bm-3">
    <a class="bookmark_title" href="https://example.com/no-title"></a>
  </div>

  <!-- Broken entry: no href -->
  <div class="bookmark" id="bm-4">
    <a class="bookmark_title">No href entry</a>
  </div>

  <!-- Broken entry: javascript: scheme -->
  <div class="bookmark" id="bm-5">
    <a class="bookmark_title" href="javascript:alert(1)">XSS attempt</a>
  </div>

</div>
</body></html>
`;

describe('parsePinboardPage', () => {
  it('extracts every well-formed bookmark, skipping the broken ones', () => {
    const entries = parsePinboardPage(FIXTURE);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.title).toBe('First article');
    expect(entries[1]?.title).toBe('Second article');
  });

  it('preserves description when present', () => {
    const [first] = parsePinboardPage(FIXTURE);
    expect(first?.description).toBe('A short blurb about the first article.');
  });

  it('omits description when no <div class="description"> sibling exists', () => {
    const [, second] = parsePinboardPage(FIXTURE);
    expect(second?.description).toBeUndefined();
  });

  it('lowercases tag values and dedupes within an entry', () => {
    const [, second] = parsePinboardPage(FIXTURE);
    expect(second?.tags).toEqual(['rust', 'async']);
  });

  it('canonicalises the URL — strips tracking params, fragment, trailing slash, lowercases', () => {
    const [, second] = parsePinboardPage(FIXTURE);
    expect(second?.url).toBe('https://example.com/article-two');
  });

  it('drops javascript: / data: URLs as a precaution', () => {
    const ids = parsePinboardPage(FIXTURE).map((e) => e.url);
    expect(ids.find((u) => u.startsWith('javascript'))).toBeUndefined();
  });

  it('returns an empty array on empty / unrelated HTML', () => {
    expect(parsePinboardPage('')).toEqual([]);
    expect(parsePinboardPage('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });
});

describe('canonicalizeUrl', () => {
  it('strips trailing slashes', () => {
    expect(canonicalizeUrl('https://example.com/foo/')).toBe('https://example.com/foo');
  });
  it('strips fragments', () => {
    expect(canonicalizeUrl('https://example.com/foo#bar')).toBe('https://example.com/foo');
  });
  it('strips utm and click-id query params', () => {
    expect(canonicalizeUrl('https://example.com/x?utm_source=tw&fbclid=abc&keep=true')).toBe(
      'https://example.com/x?keep=true',
    );
  });
  it('rejects non-http(s) schemes', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('data:text/html,foo')).toBeNull();
    expect(canonicalizeUrl('ftp://example.com/x')).toBeNull();
  });
  it('returns null on garbage input', () => {
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('')).toBeNull();
  });
});

describe('dedupe', () => {
  const a: PinboardEntry = { url: 'https://x', title: 'A', tags: ['a'] };
  const b: PinboardEntry = { url: 'https://x', title: 'A', tags: ['a', 'b'], description: 'desc' };
  const c: PinboardEntry = { url: 'https://y', title: 'C', tags: [] };

  it('keeps a single entry per URL', () => {
    expect(dedupe([a, b])).toHaveLength(1);
  });
  it('prefers the higher-fidelity entry (more tags + has description)', () => {
    expect(dedupe([a, b])[0]).toBe(b);
  });
  it('preserves URLs that only appear once', () => {
    expect(dedupe([a, c])).toHaveLength(2);
  });
});

describe('shuffle', () => {
  it('returns a permutation of the input (no add / drop / clone)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = shuffle(input);
    expect(out.slice().sort((a, b) => a - b)).toEqual(input);
  });
  it('does not mutate the input', () => {
    const input = [1, 2, 3];
    shuffle(input);
    expect(input).toEqual([1, 2, 3]);
  });
  it('is deterministic when a seeded random is injected', () => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9, 0.3, 0.7];
    const rnd = () => seq[i++ % seq.length] ?? 0;
    const a = shuffle([1, 2, 3, 4, 5], rnd);
    i = 0;
    const b = shuffle([1, 2, 3, 4, 5], rnd);
    expect(a).toEqual(b);
  });
});
