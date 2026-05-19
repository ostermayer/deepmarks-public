import { describe, expect, it } from 'vitest';
import { parseQuery } from './search.js';

const normalizeTag = (tag: string) => tag.trim().toLowerCase().replace(/^#/, '');

describe('parseQuery', () => {
  it('parses the search syntax shown in the web and app help text', () => {
    const query = parseQuery(
      '#bitcoin site:paulgraham.com after:2024-01-01 before:2024-12-31 essay',
      normalizeTag,
    );

    expect(query).toMatchObject({
      q: 'essay',
      tags: ['bitcoin'],
      site: 'paulgraham.com',
      after: Date.parse('2024-01-01T00:00:00Z') / 1000,
      before: Date.parse('2024-12-31T00:00:00Z') / 1000,
    });
  });

  it('accepts uppercase date modifiers', () => {
    const query = parseQuery('AFTER:2024-01-01 BEFORE:2024-12-31', normalizeTag);

    expect(query.after).toBe(Date.parse('2024-01-01T00:00:00Z') / 1000);
    expect(query.before).toBe(Date.parse('2024-12-31T00:00:00Z') / 1000);
  });
});
