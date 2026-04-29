import { describe, it, expect } from 'vitest';
import { parsePocket } from './pocket.js';

describe('parsePocket', () => {
  it('maps pocket CSV to BookmarkInput', () => {
    const csv = `title,url,time_added,tags,status
Some Article,https://example.com/post,1700000000,bitcoin|tech,unread
,https://example.com/no-title,1700000100,,archive`;
    const out = parsePocket(csv);
    expect(out).toEqual([
      {
        url: 'https://example.com/post',
        title: 'Some Article',
        tags: ['bitcoin', 'tech'],
        publishedAt: 1700000000
      },
      {
        url: 'https://example.com/no-title',
        title: undefined,
        tags: [],
        publishedAt: 1700000100
      }
    ]);
  });

  it('skips rows with no url', () => {
    const csv = `title,url\nfoo,\nbar,https://x`;
    const out = parsePocket(csv);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://x');
  });
});
