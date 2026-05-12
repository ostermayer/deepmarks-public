import { KIND } from './kinds.js';
import { NIP89_CLIENT_TAG, type UnsignedEventTemplate } from './bookmarks.js';

export interface SocialPostInput {
  url: string;
  title?: string;
  description?: string;
  content?: string;
  bookmarkEventId?: string;
  bookmarkAuthor?: string;
}

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

export function defaultSocialPostText(input: Pick<SocialPostInput, 'url' | 'title' | 'description'>): string {
  const title = clean(input.title);
  const description = clean(input.description);
  const url = clean(input.url);
  return [title, description, url].filter(Boolean).join('\n\n');
}

export function buildSocialPostEvent(input: SocialPostInput): UnsignedEventTemplate {
  const url = clean(input.url);
  if (!url) throw new Error('URL is required for a social post');
  const content = clean(input.content) || defaultSocialPostText(input);
  if (!content) throw new Error('Social post cannot be empty');

  const tags: string[][] = [
    ['r', url],
    ['t', 'deepmarks'],
    NIP89_CLIENT_TAG,
  ];
  if (input.bookmarkAuthor) tags.push(['a', `39701:${input.bookmarkAuthor}:${url}`]);

  return {
    kind: KIND.note,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
}
