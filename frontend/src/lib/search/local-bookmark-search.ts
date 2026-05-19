import type { ParsedBookmark } from '$lib/nostr/bookmarks';

export interface LocalBookmarkSearchOptions {
  limit?: number;
}

interface ParsedLocalQuery {
  terms: string[];
  tags: string[];
  site?: string;
  after?: number;
  before?: number;
}

export function searchLocalBookmarks(
  bookmarks: ParsedBookmark[],
  rawQuery: string,
  opts: LocalBookmarkSearchOptions = {},
): ParsedBookmark[] {
  const parsed = parseLocalQuery(rawQuery);
  if (!hasSearchIntent(parsed)) return [];

  return bookmarks
    .map((bookmark) => ({ bookmark, score: scoreBookmark(bookmark, parsed) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.bookmark.savedAt - a.bookmark.savedAt)
    .slice(0, opts.limit ?? 100)
    .map((row) => row.bookmark);
}

function parseLocalQuery(rawQuery: string): ParsedLocalQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  let site: string | undefined;
  let after: number | undefined;
  let before: number | undefined;

  for (const token of rawQuery.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) {
      const tag = normalizeTag(token.slice(1));
      if (tag) tags.push(tag);
      continue;
    }

    const tagMatch = /^tag:(.+)$/i.exec(token);
    if (tagMatch?.[1]) {
      const tag = normalizeTag(tagMatch[1]);
      if (tag) tags.push(tag);
      continue;
    }

    const siteMatch = /^site:(.+)$/i.exec(token);
    if (siteMatch?.[1]) {
      site = siteMatch[1].toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
      continue;
    }

    const dateMatch = /^(after|before):(.+)$/i.exec(token);
    if (dateMatch?.[1] && dateMatch[2]) {
      const parsedDate = parseDateStart(dateMatch[2]);
      if (parsedDate !== null) {
        if (dateMatch[1].toLowerCase() === 'after') after = parsedDate;
        else before = parsedDate;
        continue;
      }
    }

    // Global-only modifiers should not make personal search fail.
    if (/^(?:@|by:|saves:|zaps:|sats:)/i.test(token)) continue;

    terms.push(token.toLowerCase());
  }

  return { terms, tags, site, after, before };
}

function hasSearchIntent(query: ParsedLocalQuery): boolean {
  return query.terms.length > 0 || query.tags.length > 0 || !!query.site || !!query.after || !!query.before;
}

function scoreBookmark(bookmark: ParsedBookmark, query: ParsedLocalQuery): number {
  if (query.after && bookmark.savedAt < query.after) return 0;
  if (query.before && bookmark.savedAt > query.before) return 0;
  if (query.site && !bookmarkHost(bookmark.url).endsWith(query.site)) return 0;

  const bookmarkTags = bookmark.tags.map(normalizeTag);
  if (query.tags.some((tag) => !bookmarkTags.includes(tag))) return 0;

  const title = bookmark.title.toLowerCase();
  const description = bookmark.description.toLowerCase();
  const url = bookmark.url.toLowerCase();
  const tags = bookmarkTags.join(' ');
  const haystack = `${title}\n${description}\n${url}\n${tags}`;

  let score = 1;
  for (const term of query.terms) {
    if (!haystack.includes(term)) return 0;
    if (title.includes(term)) score += 12;
    if (tags.includes(term)) score += 8;
    if (description.includes(term)) score += 4;
    if (url.includes(term)) score += 2;
  }
  score += query.tags.length * 10;
  if (query.site) score += 6;
  return score;
}

function bookmarkHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/g, '');
}

function parseDateStart(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(value)) return null;
  const normalized = value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value;
  const time = Date.parse(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  return Math.floor(time / 1000);
}
