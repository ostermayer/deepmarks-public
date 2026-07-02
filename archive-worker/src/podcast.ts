import {
  tryDownloadDirectFileArchive,
  tryDownloadDirectFileArchiveToFile,
  type DirectFileArchive,
  type DirectFileArchiveOnDisk,
} from './direct-file.js';
import { assertSafePublicHttpUrl, safeFetch } from './safe-url.js';

const UA = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';
const PAGE_TIMEOUT_MS = 20_000;
const FEED_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FEED_BYTES = 5 * 1024 * 1024;

export interface PodcastEpisodeArchive extends DirectFileArchive {
  sourceUrl: string;
  title?: string;
}

export interface PodcastEpisodeFileArchive extends DirectFileArchiveOnDisk {
  sourceUrl: string;
  title?: string;
}

export async function tryResolvePodcastEpisodeArchive(
  pageUrl: string,
  opts: { maxBytes?: number } = {},
): Promise<PodcastEpisodeArchive | null> {
  const enclosure = await resolvePodcastEnclosure(pageUrl);
  if (!enclosure) return null;
  const archive = await tryDownloadDirectFileArchive(enclosure.url, { force: true, maxBytes: opts.maxBytes });
  if (!archive || !archive.contentType.startsWith('audio/')) return null;
  return {
    ...archive,
    sourceUrl: enclosure.url,
    title: enclosure.title,
  };
}

export async function tryResolvePodcastEpisodeFileArchive(
  pageUrl: string,
  opts: { maxBytes?: number; tempDir?: string } = {},
): Promise<PodcastEpisodeFileArchive | null> {
  const enclosure = await resolvePodcastEnclosure(pageUrl);
  if (!enclosure) return null;
  const archive = await tryDownloadDirectFileArchiveToFile(enclosure.url, {
    force: true,
    maxBytes: opts.maxBytes,
    tempDir: opts.tempDir,
  });
  if (!archive || !archive.contentType.startsWith('audio/')) {
    await archive?.cleanup().catch(() => undefined);
    return null;
  }
  return {
    ...archive,
    sourceUrl: enclosure.url,
    title: enclosure.title,
  };
}

async function resolvePodcastEnclosure(pageUrl: string): Promise<{ url: string; title?: string } | null> {
  const page = await fetchText(pageUrl, MAX_PAGE_BYTES, PAGE_TIMEOUT_MS);
  if (!page) return null;

  const feedUrls = podcastFeedUrls(pageUrl, page).slice(0, 4);
  for (const feedUrl of feedUrls) {
    const feed = await fetchText(feedUrl, MAX_FEED_BYTES, FEED_TIMEOUT_MS);
    if (!feed) continue;
    const enclosure = enclosureForPage(feed, pageUrl) ?? singleAudioEnclosure(feed);
    if (!enclosure) continue;
    return enclosure;
  }
  return null;
}

function podcastFeedUrls(pageUrl: string, html: string): string[] {
  const urls = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRe)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase() ?? '';
    const type = attr(tag, 'type')?.toLowerCase() ?? '';
    const href = attr(tag, 'href');
    if (!href) continue;
    if (!rel.includes('alternate')) continue;
    if (!/(rss|atom|xml)/.test(type)) continue;
    urls.add(new URL(htmlDecode(href), pageUrl).toString());
  }
  return [...urls];
}

function enclosureForPage(feed: string, pageUrl: string): { url: string; title?: string } | null {
  const normalizedPage = normalizeUrlForCompare(pageUrl);
  for (const item of feedItems(feed)) {
    if (!item.includes('<enclosure') && !item.includes('rel="enclosure"') && !item.includes("rel='enclosure'")) continue;
    const itemUrls = itemPageUrls(item).map((value) => normalizeUrlForCompare(value));
    if (!itemUrls.includes(normalizedPage)) continue;
    const enclosure = enclosureFromItem(item);
    if (enclosure) return { ...enclosure, title: textOf(item, 'title') ?? undefined };
  }
  return null;
}

function singleAudioEnclosure(feed: string): { url: string; title?: string } | null {
  const matches: Array<{ url: string; title?: string }> = [];
  for (const item of feedItems(feed)) {
    const enclosure = enclosureFromItem(item);
    if (enclosure) matches.push({ ...enclosure, title: textOf(item, 'title') ?? undefined });
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

function enclosureFromItem(item: string): { url: string } | null {
  const enclosureRe = /<enclosure\b[^>]*>/gi;
  for (const match of item.matchAll(enclosureRe)) {
    const tag = match[0];
    const type = attr(tag, 'type')?.toLowerCase() ?? '';
    if (type && !type.startsWith('audio/')) continue;
    const url = attr(tag, 'url');
    if (url) return { url: htmlDecode(url) };
  }
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of item.matchAll(linkRe)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('enclosure')) continue;
    const type = attr(tag, 'type')?.toLowerCase() ?? '';
    if (type && !type.startsWith('audio/')) continue;
    const href = attr(tag, 'href');
    if (href) return { url: htmlDecode(href) };
  }
  return null;
}

function itemPageUrls(item: string): string[] {
  const urls = [textOf(item, 'link'), textOf(item, 'guid')].filter(Boolean) as string[];
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of item.matchAll(linkRe)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase() ?? '';
    if (rel && !rel.split(/\s+/).includes('alternate')) continue;
    const href = attr(tag, 'href');
    if (href) urls.push(htmlDecode(href));
  }
  return urls;
}

function feedItems(feed: string): string[] {
  const items = [...feed.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  if (items.length > 0) return items;
  return [...feed.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function textOf(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const value = xml.match(re)?.[1]?.trim();
  return value ? htmlDecode(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : null;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(re);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function normalizeUrlForCompare(raw: string): string {
  try {
    const url = new URL(htmlDecode(raw));
    url.hash = '';
    const normalized = url.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return raw.trim();
  }
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchText(rawUrl: string, maxBytes: number, timeoutMs: number): Promise<string | null> {
  let url: URL;
  try {
    url = await assertSafePublicHttpUrl(rawUrl);
  } catch {
    return null;
  }
  // safeFetch pins the validated IP into the connect (DNS-rebinding guard).
  const res = await safeFetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.7',
    },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!res?.ok) return null;
  const contentLength = Number(res.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  // Stream with a running byte cap instead of buffering the whole body —
  // a chunked response with no/false Content-Length would otherwise OOM
  // the worker (default 4 concurrent jobs, 4 GB mem_limit).
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
