import { describe, it, expect } from 'vitest';
import { parseNetscape } from './netscape.js';

describe('parseNetscape', () => {
  it('extracts url, title, tags, add_date, and description', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://example.com/foo" ADD_DATE="1700000000" TAGS="alpha,beta,gamma">Foo Page</A>
  <DD>some description here
  <DT><A HREF="https://example.com/bar" ADD_DATE="1700000100">Bar Page</A>
</DL>`;
    const out = parseNetscape(html);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      url: 'https://example.com/foo',
      title: 'Foo Page',
      description: 'some description here',
      tags: ['alpha', 'beta', 'gamma'],
      publishedAt: 1700000000
    });
    expect(out[1]).toMatchObject({
      url: 'https://example.com/bar',
      title: 'Bar Page',
      tags: [],
      publishedAt: 1700000100
    });
    expect(out[1]?.description).toBeUndefined();
  });

  it('decodes HTML entities in titles', () => {
    const html = `<DT><A HREF="https://x.test">A &amp; B &lt;or C&gt;</A>`;
    const out = parseNetscape(html);
    expect(out[0]?.title).toBe('A & B <or C>');
  });

  it('skips entries without HREF', () => {
    const html = `<DT><A NAME="anchor">no href here</A>`;
    expect(parseNetscape(html)).toHaveLength(0);
  });

  it('returns an empty array on empty input', () => {
    expect(parseNetscape('')).toEqual([]);
  });

  it('lowercases and trims tag values', () => {
    const html = `<DT><A HREF="https://x.test" TAGS=" Bitcoin , LIGHTNING ">x</A>`;
    expect(parseNetscape(html)[0]?.tags).toEqual(['bitcoin', 'lightning']);
  });
});
