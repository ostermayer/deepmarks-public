import { describe, expect, it } from 'vitest';
import { buildBookmarkTemplate, buildSocialPostContent, buildSocialPostTemplate } from './runner.js';
import type { PinboardEntry } from './pinboard.js';

const entry: PinboardEntry = {
  url: 'https://example.com/story',
  title: 'Useful story',
  description: 'A public bookmark worth sharing.',
  tags: ['nostr'],
  count: 42,
};

describe('daily Pinboard event templates', () => {
  it('does not expose Pinboard save counts in the social note', () => {
    const content = buildSocialPostContent(entry);

    expect(content).toContain('Useful story');
    expect(content).toContain('https://example.com/story');
    expect(content).not.toContain('Pinboard saves');
    expect(content).not.toContain('42');
  });

  it('does not expose Pinboard save counts as bookmark tags', () => {
    const event = buildBookmarkTemplate(entry);

    expect(event.tags.find((tag) => tag[0] === 'pinboard-count')).toBeUndefined();
  });

  it('does not make the social note look like a reply in Nostr clients', () => {
    const bookmark = {
      id: 'b'.repeat(64),
      pubkey: 'a'.repeat(64),
      kind: 39701,
      created_at: 1_700_000_000,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    };

    const note = buildSocialPostTemplate(entry, bookmark);

    expect(note.tags.find((tag) => tag[0] === 'e')).toBeUndefined();
    expect(note.tags).toContainEqual(['r', entry.url]);
    expect(note.tags).toContainEqual(['a', `39701:${bookmark.pubkey}:${entry.url}`]);
  });
});
