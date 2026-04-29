import { describe, it, expect } from 'vitest';
import type { ParsedBookmark } from '$lib/nostr/bookmarks';
import { generateNetscape } from './netscape.js';
import { generatePinboard } from './pinboard.js';
import { generateCsv } from './csv.js';
import { generateJsonl } from './jsonl.js';
import { parseNetscape } from '$lib/importers/netscape.js';
import { parsePinboard } from '$lib/importers/pinboard.js';
import { parseCsv } from '$lib/importers/csv.js';

const sample: ParsedBookmark[] = [
  {
    url: 'https://example.com/foo',
    title: 'Foo & Bar',
    description: 'has "quotes", commas, and\nnewlines',
    tags: ['bitcoin', 'lightning'],
    archivedForever: true,
    savedAt: 1700000000,
    curator: 'pubkey-1',
    eventId: 'evt-1'
  },
  {
    url: 'https://example.com/bar',
    title: 'Plain entry',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 1700000100,
    curator: 'pubkey-2',
    eventId: 'evt-2'
  }
];

describe('generateNetscape', () => {
  it('round-trips through parseNetscape preserving url/title/tags/savedAt', () => {
    const html = generateNetscape(sample);
    const parsed = parseNetscape(html);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      url: 'https://example.com/foo',
      title: 'Foo & Bar',
      tags: ['bitcoin', 'lightning'],
      publishedAt: 1700000000
    });
    expect(parsed[1]?.tags).toEqual([]);
  });

  it('escapes HTML entities in titles', () => {
    const html = generateNetscape([
      { ...sample[0]!, title: 'A <b>B</b> & C' }
    ]);
    expect(html).toContain('A &lt;b&gt;B&lt;/b&gt; &amp; C');
  });
});

describe('generatePinboard', () => {
  it('round-trips through parsePinboard', () => {
    const json = generatePinboard(sample);
    const parsed = parsePinboard(json);
    expect(parsed[0]).toMatchObject({
      url: 'https://example.com/foo',
      title: 'Foo & Bar',
      description: 'has "quotes", commas, and\nnewlines',
      tags: ['bitcoin', 'lightning']
    });
  });

  it('emits ISO timestamps', () => {
    const out = JSON.parse(generatePinboard(sample)) as { time: string }[];
    expect(out[0]?.time).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('generateCsv', () => {
  it('round-trips header + values through parseCsv', () => {
    const csv = generateCsv(sample);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual({
      url: 'https://example.com/foo',
      title: 'Foo & Bar',
      description: 'has "quotes", commas, and\nnewlines',
      tags: 'bitcoin lightning',
      saved_at: '1700000000',
      archived_forever: 'true'
    });
  });

  it('quotes fields with commas, newlines, or quotes', () => {
    const csv = generateCsv([sample[0]!]);
    expect(csv).toContain('"has ""quotes"", commas, and\nnewlines"');
  });
});

describe('generateJsonl', () => {
  it('emits one JSON object per line', () => {
    const events = [
      { id: '1', kind: 39701, pubkey: 'p', created_at: 0, tags: [], content: '' },
      { id: '2', kind: 39701, pubkey: 'p', created_at: 1, tags: [], content: '' }
    ];
    const out = generateJsonl(events);
    expect(out.split('\n')).toHaveLength(2);
    expect(JSON.parse(out.split('\n')[0]!)).toMatchObject({ id: '1' });
  });
});
