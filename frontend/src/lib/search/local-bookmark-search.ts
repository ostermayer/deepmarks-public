import { bookmarkSortTimeMs, type ParsedBookmark } from '$lib/nostr/bookmarks';
import { normalizeNaturalSearchQuery } from './natural-query';

export interface LocalBookmarkSearchOptions {
  limit?: number;
}

interface ParsedLocalQuery {
  terms: string[];
  tags: string[];
  site?: string;
  filetype?: string;
  hasPdf?: boolean;
  scholarly?: boolean;
  after?: number;
  before?: number;
}

export function searchLocalBookmarks(
  bookmarks: ParsedBookmark[],
  rawQuery: string,
  opts: LocalBookmarkSearchOptions = {},
): ParsedBookmark[] {
  const normalized = normalizeNaturalSearchQuery(rawQuery);
  const parsed = parseLocalQuery(normalized.query);
  if (!hasSearchIntent(parsed)) return [];

  return bookmarks
    .map((bookmark) => ({ bookmark, score: scoreBookmark(bookmark, parsed) }))
    .filter((row) => row.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      bookmarkSortTimeMs(b.bookmark) - bookmarkSortTimeMs(a.bookmark) ||
      b.bookmark.eventId.localeCompare(a.bookmark.eventId)
    )
    .slice(0, opts.limit ?? 100)
    .map((row) => row.bookmark);
}

function parseLocalQuery(rawQuery: string): ParsedLocalQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  let site: string | undefined;
  let filetype: string | undefined;
  let hasPdf = false;
  let scholarly = false;
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

    const filetypeMatch = /^(?:filetype|type):(.+)$/i.exec(token);
    if (filetypeMatch?.[1]) {
      filetype = filetypeMatch[1].toLowerCase().replace(/^\./, '');
      continue;
    }

    if (/^has:pdf$/i.test(token)) {
      hasPdf = true;
      continue;
    }

    const scholarlyMatch = /^scholarly:(?:1|true|yes)$/i.exec(token);
    if (scholarlyMatch) {
      scholarly = true;
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

  return { terms, tags, site, filetype, hasPdf, scholarly, after, before };
}

function hasSearchIntent(query: ParsedLocalQuery): boolean {
  return query.terms.length > 0 || query.tags.length > 0 || !!query.site || !!query.filetype || !!query.hasPdf || !!query.scholarly || !!query.after || !!query.before;
}

function scoreBookmark(bookmark: ParsedBookmark, query: ParsedLocalQuery): number {
  if (query.after && bookmark.savedAt < query.after) return 0;
  if (query.before && bookmark.savedAt > query.before) return 0;
  if (query.site && !bookmarkHost(bookmark.url).endsWith(query.site)) return 0;
  if (query.filetype && bookmarkFiletype(bookmark.url) !== query.filetype) return 0;
  if (query.hasPdf && !bookmarkHasPdf(bookmark.url)) return 0;
  if (query.scholarly && !isScholarlyBookmark(bookmark)) return 0;

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
  if (query.filetype) score += 4;
  if (query.hasPdf) score += 4;
  if (query.scholarly) score += 5;
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

function bookmarkFiletype(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\/pdf(?:\/|$)/.test(pathname)) return 'pdf';
    const match = /\.([a-z0-9]{2,8})(?:$|[?#/])/.exec(pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function bookmarkHasPdf(url: string): boolean {
  if (bookmarkFiletype(url) === 'pdf') return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();
    if (host === 'arxiv.org' && /^\/abs\//.test(path)) return true;
    if (host === 'pmc.ncbi.nlm.nih.gov' && /^\/articles\/pmc\d+\/?$/.test(path)) return true;
    if ((host === 'biorxiv.org' || host === 'medrxiv.org') && /\/content\//.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

const SCHOLARLY_DOMAINS = [
  'academia.edu',
  'arxiv.org',
  'biorxiv.org',
  'cambridge.org',
  'cell.com',
  'doi.org',
  'frontiersin.org',
  'jamanetwork.com',
  'jbc.org',
  'medrxiv.org',
  'nature.com',
  'nejm.org',
  'nih.gov',
  'osf.io',
  'plos.org',
  'pubmed.ncbi.nlm.nih.gov',
  'researchgate.net',
  'sciencedirect.com',
  'science.org',
  'springer.com',
  'tandfonline.com',
  'wiley.com',
];

function isScholarlyBookmark(bookmark: ParsedBookmark): boolean {
  const host = bookmarkHost(bookmark.url);
  if (host.endsWith('.edu') || SCHOLARLY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }
  const text = `${bookmark.title}\n${bookmark.description}\n${bookmark.tags.join(' ')}`.toLowerCase();
  return /\b(?:abstract|academic|arxiv|doi|journal|meta-analysis|paper|preprint|pubmed|randomi[sz]ed|research|review|scholarly|study|trial)\b/.test(text);
}
