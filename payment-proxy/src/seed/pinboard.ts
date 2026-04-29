// Pinboard popular/recent page parser.
//
// Pinboard's public listings render as plain server-side HTML (no JS needed)
// with a stable structure that's been the same for 15+ years:
//
//   <div class="bookmark">
//     <a class="bookmark_title" href="...">Title</a>
//     <div class="description">…</div>          (optional)
//     <div class="bookmark_details">
//       … <a class="tag" href="...">tag1</a> <a class="tag" href="...">tag2</a> …
//     </div>
//   </div>
//
// We pull each block, harvest URL + visible title + tags + (optional)
// description, drop entries that look broken. The parser is pure (no
// fetch, no env reads) so the test suite can hammer it against fixtures.

import { load } from 'cheerio';

export interface PinboardEntry {
  url: string;
  title: string;
  description?: string;
  tags: string[];
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

/** Lower-cased, trimmed; strips well-known tracking params; keeps fragments off. */
export function canonicalizeUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return null;
  }
}

export function parsePinboardPage(html: string): PinboardEntry[] {
  const $ = load(html);
  const out: PinboardEntry[] = [];
  $('div.bookmark').each((_, el) => {
    const $bm = $(el);
    const $title = $bm.find('a.bookmark_title').first();
    const href = $title.attr('href');
    const title = $title.text().trim();
    const url = href ? canonicalizeUrl(href) : null;
    if (!url || !title) return;
    const description = $bm.find('div.description').first().text().trim() || undefined;
    const tags: string[] = [];
    $bm.find('a.tag').each((__, t) => {
      const txt = $(t).text().trim().toLowerCase();
      if (txt && !tags.includes(txt)) tags.push(txt);
    });
    out.push({ url, title, description, tags });
  });
  return out;
}

/** De-dupe a flat list by canonical URL, preferring the entry with the most tags / a description. */
export function dedupe(entries: PinboardEntry[]): PinboardEntry[] {
  const byUrl = new Map<string, PinboardEntry>();
  for (const e of entries) {
    const existing = byUrl.get(e.url);
    if (!existing) {
      byUrl.set(e.url, e);
      continue;
    }
    const score = (x: PinboardEntry) => x.tags.length + (x.description ? 1 : 0);
    if (score(e) > score(existing)) byUrl.set(e.url, e);
  }
  return Array.from(byUrl.values());
}

/** Fisher-Yates shuffle. Pure when `random` is injected. */
export function shuffle<T>(input: T[], random: () => number = Math.random): T[] {
  const out = input.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
