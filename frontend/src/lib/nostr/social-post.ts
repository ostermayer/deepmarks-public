import { nip19 } from 'nostr-tools';
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

/** Match every `nostr:npub1…` URI in the post content. Used to derive
 *  `p` tags for mentioned pubkeys so other Nostr clients can render
 *  the inline profile reference correctly and notify the mentioned
 *  user. */
const NPUB_MENTION_RE = /nostr:(npub1[02-9ac-hj-np-z]{6,})/gi;

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

  // NIP-08-style mentions: every `nostr:npub1…` token in the post
  // content carries an implicit `p` tag for the referenced pubkey.
  // Clients like Damus and Primal render the inline pill AND notify
  // the mentioned user — without the `p` tag the mention is invisible
  // to them.
  const seenPubkeys = new Set<string>();
  for (const match of content.matchAll(NPUB_MENTION_RE)) {
    const npub = match[1];
    if (!npub) continue;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') continue;
      const hex = (decoded.data as string).toLowerCase();
      if (seenPubkeys.has(hex)) continue;
      seenPubkeys.add(hex);
      tags.push(['p', hex]);
    } catch { /* malformed npub — skip */ }
  }

  return {
    kind: KIND.note,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
}
