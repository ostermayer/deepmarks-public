import { describe, expect, it } from 'vitest';
import { buildSocialPostEvent, defaultSocialPostText } from './social-post.js';
import { KIND } from './kinds.js';

describe('defaultSocialPostText', () => {
  it('prefills title, description, and URL with editable plain text', () => {
    expect(
      defaultSocialPostText({
        title: 'A good link',
        description: 'Useful context',
        url: 'https://example.com',
      }),
    ).toBe('A good link\n\nUseful context\n\nhttps://example.com');
  });

  it('falls back to the URL when title and description are blank', () => {
    expect(defaultSocialPostText({ url: 'https://example.com' })).toBe('https://example.com');
  });
});

describe('buildSocialPostEvent', () => {
  it('builds a top-level kind:1 note linked to the bookmark address and URL', () => {
    const event = buildSocialPostEvent({
      url: 'https://example.com',
      title: 'A good link',
      description: 'Useful context',
      bookmarkEventId: 'evt1',
      bookmarkAuthor: 'a'.repeat(64),
    });

    expect(event.kind).toBe(KIND.note);
    expect(event.content).toContain('A good link');
    expect(event.tags).toContainEqual(['r', 'https://example.com']);
    expect(event.tags.find((t) => t[0] === 'e')).toBeUndefined();
    expect(event.tags).toContainEqual(['a', `39701:${'a'.repeat(64)}:https://example.com`]);
    expect(event.tags.find((t) => t[0] === 'client')?.[1]).toBe('Deepmarks');
  });
});
