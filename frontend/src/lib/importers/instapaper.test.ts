import { describe, it, expect } from 'vitest';
import { parseInstapaper } from './instapaper.js';

describe('parseInstapaper', () => {
  it('reads URL/Title/Selection/Folder/Timestamp columns', () => {
    const csv = `URL,Title,Selection,Folder,Timestamp
https://x.com,Title A,a quote,Reading,1700000000
https://y.com,Title B,,,1700000100`;
    const out = parseInstapaper(csv);
    expect(out).toEqual([
      {
        url: 'https://x.com',
        title: 'Title A',
        description: 'a quote',
        tags: ['reading'],
        publishedAt: 1700000000
      },
      {
        url: 'https://y.com',
        title: 'Title B',
        description: undefined,
        tags: [],
        publishedAt: 1700000100
      }
    ]);
  });

  it('accepts lowercase column names', () => {
    const csv = `url,title\nhttps://x,Foo`;
    expect(parseInstapaper(csv)[0]?.title).toBe('Foo');
  });

  it('drops rows without URL', () => {
    const csv = `URL,Title\n,Empty\nhttps://ok,Ok`;
    expect(parseInstapaper(csv)).toHaveLength(1);
  });
});
