import { describe, it, expect } from 'vitest';
import { userStatsFrom } from './user-stats.js';
import type { ParsedBookmark } from './bookmarks.js';

function bm(overrides: Partial<ParsedBookmark> = {}): ParsedBookmark {
  return {
    url: 'https://x.test',
    title: 't',
    description: '',
    tags: [],
    archivedForever: false,
    savedAt: 0,
    curator: 'pub',
    eventId: `${Math.random()}`,
    ...overrides,
  };
}

describe('userStatsFrom', () => {
  it('counts marks + archived-forever distinct from total', () => {
    const s = userStatsFrom([
      bm({ archivedForever: true }),
      bm({ archivedForever: false }),
      bm({ archivedForever: true }),
    ]);
    expect(s.marked).toBe(3);
    expect(s.archivedForever).toBe(2);
  });

  it('counts distinct tags across bookmarks, lowercased', () => {
    const s = userStatsFrom([
      bm({ tags: ['Bitcoin', 'lightning'] }),
      bm({ tags: ['bitcoin', 'nostr'] }),
    ]);
    expect(s.tagsUsed).toBe(3);
  });

  it('zeros everything for empty input', () => {
    expect(userStatsFrom([])).toEqual({
      marked: 0,
      archivedForever: 0,
      tagsUsed: 0,
      satsSent: null,
      satsReceived: null,
    });
  });

  it('leaves satsSent / satsReceived null until wired', () => {
    const s = userStatsFrom([bm()]);
    expect(s.satsSent).toBeNull();
    expect(s.satsReceived).toBeNull();
  });

  it('ignores whitespace-only tags', () => {
    const s = userStatsFrom([bm({ tags: ['', '   ', 'real'] })]);
    expect(s.tagsUsed).toBe(1);
  });
});
