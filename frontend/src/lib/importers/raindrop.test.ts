import { describe, it, expect } from 'vitest';
import { parseRaindrop } from './raindrop.js';

describe('parseRaindrop', () => {
  it('extracts title, note, tags, folder, created', () => {
    const csv = `id,title,note,excerpt,url,folder,tags,created
1,Foo,my note,excerpt-text,https://foo.test,Reading,bitcoin,2024-01-15T12:00:00Z
2,Bar,,fallback excerpt,https://bar.test,,nostr,2024-02-01T00:00:00Z`;
    const out = parseRaindrop(csv);
    expect(out[0]).toEqual({
      url: 'https://foo.test',
      title: 'Foo',
      description: 'my note',
      tags: ['bitcoin', 'reading'],
      publishedAt: Math.floor(Date.parse('2024-01-15T12:00:00Z') / 1000)
    });
    expect(out[1]?.description).toBe('fallback excerpt');
    expect(out[1]?.tags).toEqual(['nostr']);
  });

  it('skips rows without url', () => {
    expect(parseRaindrop('id,url\n1,\n2,https://ok')).toHaveLength(1);
  });
});
