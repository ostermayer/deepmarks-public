import { describe, it, expect } from 'vitest';
import { parsePinboard } from './pinboard.js';
import { ImportError } from './types.js';

describe('parsePinboard', () => {
  it('maps pinboard fields to BookmarkInput', () => {
    const json = JSON.stringify([
      {
        href: 'https://example.com/x',
        description: 'Example',
        extended: 'long description',
        time: '2024-01-15T12:00:00Z',
        tags: 'bitcoin lightning'
      }
    ]);
    const out = parsePinboard(json);
    expect(out).toEqual([
      {
        url: 'https://example.com/x',
        title: 'Example',
        description: 'long description',
        tags: ['bitcoin', 'lightning'],
        publishedAt: Math.floor(Date.parse('2024-01-15T12:00:00Z') / 1000)
      }
    ]);
  });

  it('skips entries without href', () => {
    const out = parsePinboard(JSON.stringify([{ description: 'no url' }, { href: 'https://ok' }]));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://ok');
  });

  it('throws ImportError on invalid JSON', () => {
    expect(() => parsePinboard('not json')).toThrow(ImportError);
  });

  it('throws ImportError when top level is not an array', () => {
    expect(() => parsePinboard('{}')).toThrow(ImportError);
  });

  it('handles empty tag string', () => {
    const out = parsePinboard(JSON.stringify([{ href: 'https://x', tags: '' }]));
    expect(out[0]?.tags).toEqual([]);
  });
});
