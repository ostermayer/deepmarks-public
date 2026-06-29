import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

import { enqueueLifetimeArchive } from './archive-purchase.js';
import {
  ARCHIVE_FAILURE_PREFIX,
  listArchiveFailures,
  parseArchiveFailureRecord,
  type ArchiveFailureRecord,
  type ArchiveFailureRescueSummary,
  updateArchiveFailureRescue,
} from './archive-failures.js';
import type { DeepInfraClient } from './llm.js';
import type {
  ArchiveRescueSearchClient,
  ArchiveRescueSearchResult,
} from './archive-rescue-search.js';
import type { PurchaseStore } from './queue.js';
import {
  assertSafeResolvedPublicHttpUrl,
  type PublicDnsLookup,
  validateSafePublicHttpUrl,
} from './safe-url.js';

const RESCUE_CLAIM_PREFIX = 'dm:archive-rescue:claim:';
const RESCUE_CLAIM_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_VERIFY_CANDIDATES = 12;
const MAX_RESCUE_BATCH = 50;
const VERIFY_TIMEOUT_MS = 8_000;
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_SCHOLARLY_METADATA_BYTES = 128 * 1024;
// Reject candidates that pass the header checks but return a near-empty
// body — a bot-challenge / rate-limit page that would archive to nothing.
const MIN_ARCHIVE_CONTENT_BYTES = 2048;
// How much of the candidate body we read to validate it.
const VERIFY_BODY_LIMIT_BYTES = 262144;
// A realistic browser User-Agent. Many sources (Nitter behind Cloudflare /
// Anubis, some publishers) serve real HTML to browsers but a bot challenge
// or 403 to a crawler UA — which is exactly why a URL that opens fine in
// your browser can fail to archive. Verifying with a browser UA lets us see
// what the browser actually sees.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// FixTweet-compatible providers (same JSON shape) — the archive worker rebuilds
// tweets from these by status id. A tweet rescue can't be verified by fetching
// the page (the x.com URL is an empty JS shell and the public Nitter mirrors are
// dead), so we instead confirm the tweet is servable via FixTweet here and
// enqueue the canonical x.com URL the worker's FixTweet path recognizes.
const FIXTWEET_PROVIDERS = ['https://api.fxtwitter.com', 'https://api.fixupx.com'] as const;
const FIXTWEET_USER_AGENT = 'Deepmarks-Archive/1.0 (+https://deepmarks.org/bot)';

type ArchiveRescueSource = 'known-migration' | 'social-mirror' | 'wayback' | 'llm' | 'web-search' | 'url-variant' | 'scholarly-pdf';

export interface ArchiveRescueCandidate {
  url: string;
  source: ArchiveRescueSource;
  reason: string;
  confidence: number;
}

export interface VerifiedArchiveRescueCandidate extends ArchiveRescueCandidate {
  status: number;
  finalUrl?: string;
  contentType?: string;
}

export interface ArchiveRescueResult {
  jobId: string;
  url: string;
  eligible: boolean;
  skippedReason?: string;
  candidates: ArchiveRescueCandidate[];
  verifiedCandidates: VerifiedArchiveRescueCandidate[];
  searchQueries: string[];
  enqueuedJobId?: string;
  enqueuedUrl?: string;
  checkedAt: number;
}

export interface ArchiveRescueDeps {
  redis: Redis;
  purchases: PurchaseStore;
  llm: Pick<DeepInfraClient, 'enabled' | 'suggestArchiveRescue'>;
  search?: Pick<ArchiveRescueSearchClient, 'enabled' | 'search'>;
  logger?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface ArchiveRescueOptions {
  dryRun?: boolean;
  force?: boolean;
  fetch?: typeof fetch;
  dnsLookup?: PublicDnsLookup;
  timeoutMs?: number;
  maxCandidates?: number;
}

export interface ArchiveRescueBatchOptions extends ArchiveRescueOptions {
  ownerPubkey?: string;
  limit?: number;
}

export interface ArchiveRescueBatchResult {
  scanned: number;
  processed: number;
  enqueued: number;
  skipped: number;
  dryRun: boolean;
  results: ArchiveRescueResult[];
}

export async function rescueArchiveFailure(
  deps: ArchiveRescueDeps,
  failure: ArchiveFailureRecord,
  options: ArchiveRescueOptions = {},
): Promise<ArchiveRescueResult> {
  const checkedAt = nowSeconds();
  const eligibility = archiveFailureRescueEligibility(failure);
  if (!eligibility.eligible) {
    return {
      jobId: failure.jobId,
      url: failure.url,
      eligible: false,
      skippedReason: eligibility.reason,
      candidates: [],
      verifiedCandidates: [],
      searchQueries: [],
      checkedAt,
    };
  }

  if (!options.dryRun && !options.force) {
    const claim = await deps.redis.set(
      RESCUE_CLAIM_PREFIX + failure.jobId,
      String(checkedAt),
      'EX',
      RESCUE_CLAIM_TTL_SECONDS,
      'NX',
    );
    if (claim !== 'OK') {
      return {
        jobId: failure.jobId,
        url: failure.url,
        eligible: true,
        skippedReason: 'already-claimed',
        candidates: [],
        verifiedCandidates: [],
        searchQueries: [],
        checkedAt,
      };
    }
  }

  const fetchImpl = options.fetch ?? fetch;
  let candidates: ArchiveRescueCandidate[] = [];
  let searchQueries: string[] = [];
  try {
    const gathered = await gatherArchiveRescueCandidates(deps, failure, fetchImpl, options);
    candidates = gathered.candidates;
    searchQueries = gathered.searchQueries;
  } catch (err) {
    deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue candidate gathering failed');
  }

  const verifiedCandidates = await verifyArchiveRescueCandidates(
    candidates,
    failure.url,
    fetchImpl,
    options,
  );

  let enqueuedJobId: string | undefined;
  let enqueuedUrl: string | undefined;
  let enqueueError: string | undefined;
  if (verifiedCandidates.length > 0 && !options.dryRun) {
    const best = verifiedCandidates[0];
    enqueuedUrl = best.finalUrl ?? best.url;
    enqueuedJobId = archiveRescueJobId(failure.jobId, enqueuedUrl);
    try {
      await enqueueLifetimeArchive({
        purchases: deps.purchases,
        url: enqueuedUrl,
        userPubkey: failure.ownerPubkey,
        paymentHash: enqueuedJobId,
        eventId: failure.eventId,
        tier: 'public',
        mirrorUrls: failure.mirrorUrls,
        bookmarkSavedAt: failure.bookmarkSavedAt,
        originalUrl: failure.url,
      });
      deps.logger?.info?.(
        { jobId: failure.jobId, rescueJobId: enqueuedJobId, url: failure.url, rescueUrl: enqueuedUrl },
        'archive rescue job enqueued',
      );
    } catch (err) {
      enqueueError = err instanceof Error ? err.message : String(err);
      enqueuedJobId = undefined;
      enqueuedUrl = undefined;
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue enqueue failed');
    }
  }

  const result: ArchiveRescueResult = {
    jobId: failure.jobId,
    url: failure.url,
    eligible: true,
    candidates,
    verifiedCandidates,
    searchQueries,
    enqueuedJobId,
    enqueuedUrl,
    checkedAt,
  };

  if (!options.dryRun) {
    const summary: ArchiveFailureRescueSummary = {
      status: enqueueError
        ? 'failed'
        : enqueuedJobId
          ? 'enqueued'
          : verifiedCandidates.length > 0
            ? 'candidate-found'
            : 'no-candidate',
      checkedAt,
      candidates: candidates.map(toSummaryCandidate),
      verifiedCandidates: verifiedCandidates.map(toVerifiedSummaryCandidate),
      enqueuedJobId,
      enqueuedUrl,
      searchQueries,
      error: enqueueError,
    };
    await updateArchiveFailureRescue(deps.redis, failure, summary).catch((err) => {
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue result write failed');
    });
  }

  return result;
}

export async function rescueFailedArchives(
  deps: ArchiveRescueDeps,
  options: ArchiveRescueBatchOptions = {},
): Promise<ArchiveRescueBatchResult> {
  const dryRun = options.dryRun ?? true;
  const limit = clampInt(options.limit, 1, MAX_RESCUE_BATCH, 20);
  const failures = await listFailuresForRescue(deps.redis, options.ownerPubkey, limit);
  const results: ArchiveRescueResult[] = [];
  let enqueued = 0;
  let skipped = 0;
  for (const failure of failures) {
    const result = await rescueArchiveFailure(deps, failure, { ...options, dryRun });
    results.push(result);
    if (result.enqueuedJobId) enqueued += 1;
    if (!result.eligible || result.skippedReason) skipped += 1;
  }
  return {
    scanned: failures.length,
    processed: results.length,
    enqueued,
    skipped,
    dryRun,
    results,
  };
}

export function archiveFailureRescueEligibility(
  failure: ArchiveFailureRecord,
): { eligible: true } | { eligible: false; reason: string } {
  if (failure.tier === 'private') return { eligible: false, reason: 'private-archive' };
  if (failure.jobId.startsWith('rescue:')) return { eligible: false, reason: 'rescue-job' };
  const kind = failure.kind ?? 'webpage';
  // Public webpages AND direct files (PDFs, docs) are both rescuable from
  // alternative public sources — OA-PDF mirrors, Wayback, URL variants.
  // Media (yt-dlp) stays excluded: its "alternatives" are a different
  // problem handled by the client-side media retry path.
  if (kind !== 'webpage' && kind !== 'file') {
    return { eligible: false, reason: 'non-webpage-archive' };
  }
  try {
    validateSafePublicHttpUrl(failure.url);
  } catch {
    return { eligible: false, reason: 'unsafe-source-url' };
  }
  return { eligible: true };
}

async function gatherArchiveRescueCandidates(
  deps: ArchiveRescueDeps,
  failure: ArchiveFailureRecord,
  fetchImpl: typeof fetch,
  options: ArchiveRescueOptions,
): Promise<{ candidates: ArchiveRescueCandidate[]; searchQueries: string[] }> {
  const deterministic = deterministicCandidates(failure.url);
  const socialMirror = socialMirrorCandidates(failure.url);
  const scholarlyPdf = await scholarlyPdfCandidates(failure.url, fetchImpl, options.timeoutMs ?? VERIFY_TIMEOUT_MS)
    .catch((err) => {
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue scholarly PDF lookup failed');
      return { candidates: [] as ArchiveRescueCandidate[], searchQueries: [] as string[] };
    });
  const wayback = await waybackCandidates(failure.url, fetchImpl, options.timeoutMs ?? VERIFY_TIMEOUT_MS, failure.bookmarkSavedAt)
    .catch((err) => {
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue Wayback lookup failed');
      return [];
    });
  const archiveToday = await archiveTodayCandidates(failure.url, fetchImpl, options.timeoutMs ?? VERIFY_TIMEOUT_MS)
    .catch((err) => {
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue archive.today lookup failed');
      return [];
    });
  let llmCandidates: ArchiveRescueCandidate[] = [];
  let searchCandidates: ArchiveRescueCandidate[] = [];
  let searchQueries: string[] = [];
  if (deps.llm.enabled) {
    const suggestion = await deps.llm.suggestArchiveRescue({
      url: failure.url,
      failureReason: failure.reason,
      error: failure.error,
    }).catch((err) => {
      deps.logger?.warn?.({ err, jobId: failure.jobId, url: failure.url }, 'archive rescue LLM suggestion failed');
      return null;
    });
    llmCandidates = (suggestion?.candidates ?? []).map((candidate) => ({
      url: candidate.url,
      source: 'llm' as const,
      reason: candidate.reason || 'LLM suggested public rescue URL',
      confidence: candidate.confidence,
    }));
    searchQueries = dedupeStrings(suggestion?.searchQueries ?? [], 5);
  }

  searchQueries = dedupeStrings([
    ...searchQueries,
    ...scholarlyPdf.searchQueries,
    ...defaultArchiveRescueSearchQueries(failure.url),
  ], 8);
  if (deps.search?.enabled && searchQueries.length > 0) {
    for (const query of searchQueries.slice(0, 6)) {
      const results = await deps.search.search(query, fetchImpl).catch((err) => {
        deps.logger?.warn?.({ err, jobId: failure.jobId, query }, 'archive rescue web search failed');
        return [] as ArchiveRescueSearchResult[];
      });
      searchCandidates.push(...searchResultCandidates(results, failure.url, query));
    }
  }

  const all = [...deterministic, ...socialMirror, ...scholarlyPdf.candidates, ...wayback, ...archiveToday, ...llmCandidates, ...searchCandidates]
    .map((candidate) => normalizeRescueCandidate(candidate, failure.url))
    .filter((candidate): candidate is ArchiveRescueCandidate => !!candidate);

  return {
    candidates: sortRescueCandidates(dedupeCandidates(all))
      .slice(0, options.maxCandidates ?? MAX_VERIFY_CANDIDATES),
    searchQueries,
  };
}

async function verifyArchiveRescueCandidates(
  candidates: ArchiveRescueCandidate[],
  originalUrl: string,
  fetchImpl: typeof fetch,
  options: ArchiveRescueOptions,
): Promise<VerifiedArchiveRescueCandidate[]> {
  const verified: VerifiedArchiveRescueCandidate[] = [];
  for (const candidate of candidates.slice(0, options.maxCandidates ?? MAX_VERIFY_CANDIDATES)) {
    const out = await verifyArchiveRescueCandidate(candidate, originalUrl, fetchImpl, options).catch(() => null);
    if (out) verified.push(out);
    if (verified.length >= 3) break;
  }
  return sortRescueCandidates(verified) as VerifiedArchiveRescueCandidate[];
}

async function verifyArchiveRescueCandidate(
  candidate: ArchiveRescueCandidate,
  originalUrl: string,
  fetchImpl: typeof fetch,
  options: ArchiveRescueOptions,
): Promise<VerifiedArchiveRescueCandidate | null> {
  if (!candidateAllowedForSource(candidate.url, originalUrl, candidate.source)) return null;
  // A tweet rescue is rebuilt from the FixTweet API on Box B, not from the page
  // HTML — so verify it against FixTweet (the x.com shell is empty and the
  // Nitter mirrors are dead) and enqueue the canonical x.com URL the worker
  // rebuilds from. A wrong-id "tweet" never matches here and falls through to
  // the normal HTML path, where the same-id content binding rejects it.
  const tweetCanonical = tweetRebuildCanonical(candidate.url, originalUrl);
  if (tweetCanonical) return verifyTweetViaFixTweet(tweetCanonical, candidate, fetchImpl, options);
  const parsed = await assertSafeResolvedPublicHttpUrl(candidate.url, { dnsLookup: options.dnsLookup });
  const res = await fetchImpl(parsed.toString(), {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? VERIFY_TIMEOUT_MS),
    headers: {
      'user-agent': BROWSER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.8,*/*;q=0.2',
      'accept-language': 'en-US,en;q=0.9',
      range: `bytes=0-${VERIFY_BODY_LIMIT_BYTES - 1}`,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const contentLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !isRescuableContentType(contentType)) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  // Read a bounded slice of the body to validate it actually carries content.
  const body = await readBoundedText(res, VERIFY_BODY_LIMIT_BYTES).catch(() => '');
  // Reject thin bot-challenge / rate-limit pages that pass the header checks
  // but would archive to nothing (the "output too small" failures) — this is
  // why a Nitter URL that "resolves" can still be a dead archive.
  if (body.length < MIN_ARCHIVE_CONTENT_BYTES) return null;
  // For a tweet mirror, require the fetched page to actually contain this
  // tweet — the safety binding that lets us accept host-agnostic mirrors.
  if (!tweetMirrorContentOk(parsed, originalUrl, body)) return null;
  const finalUrl = res.url && res.url !== parsed.toString() ? res.url : undefined;
  if (finalUrl) {
    await assertSafeResolvedPublicHttpUrl(finalUrl, { dnsLookup: options.dnsLookup });
    if (!candidateAllowedForSource(finalUrl, originalUrl, candidate.source)) return null;
  }
  return {
    ...candidate,
    url: parsed.toString(),
    status: res.status,
    finalUrl,
    contentType: contentType || undefined,
  };
}

function deterministicCandidates(rawUrl: string): ArchiveRescueCandidate[] {
  const parsed = validateSafePublicHttpUrl(rawUrl);
  parsed.hash = '';
  const out: ArchiveRescueCandidate[] = [];
  addCandidate(out, parsed.toString(), 'url-variant', 'Original URL with fragment removed.', 0.4);

  if (parsed.protocol === 'https:') {
    const http = new URL(parsed.toString());
    http.protocol = 'http:';
    addCandidate(out, http.toString(), 'url-variant', 'HTTP fallback for stale TLS/cipher failures.', 0.72);
  }

  const host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) {
    const withoutWww = new URL(parsed.toString());
    withoutWww.hostname = host.slice(4);
    addCandidate(out, withoutWww.toString(), 'url-variant', 'Non-www canonical host variant.', 0.62);
  } else {
    const withWww = new URL(parsed.toString());
    withWww.hostname = `www.${host}`;
    addCandidate(out, withWww.toString(), 'url-variant', 'www canonical host variant.', 0.56);
  }

  if (parsed.search || parsed.hash) {
    const stripped = new URL(parsed.toString());
    stripped.search = '';
    stripped.hash = '';
    addCandidate(out, stripped.toString(), 'url-variant', 'URL without query or fragment.', 0.55);
  }

  // Reddit blocks www aggressively; old.reddit is the more archivable frontend
  // when it's reachable. NOTE: as of testing reddit 403s old.reddit too, so
  // this is low-yield best-effort — Wayback remains the reliable fallback.
  if (/(^|\.)reddit\.com$/i.test(host) && !host.startsWith('old.')) {
    const oldReddit = new URL(parsed.toString());
    oldReddit.hostname = 'old.reddit.com';
    addCandidate(out, oldReddit.toString(), 'url-variant', 'old.reddit.com frontend variant.', 0.5);
  }

  if (!parsed.pathname.endsWith('/amp') && !parsed.pathname.endsWith('/amp/')) {
    const ampPath = new URL(parsed.toString());
    ampPath.pathname = `${ampPath.pathname.replace(/\/$/, '')}/amp`;
    addCandidate(out, ampPath.toString(), 'url-variant', 'Common AMP path variant.', 0.35);
  }
  const ampQuery = new URL(parsed.toString());
  ampQuery.searchParams.set('amp', '1');
  addCandidate(out, ampQuery.toString(), 'url-variant', 'Common AMP query variant.', 0.32);
  const printQuery = new URL(parsed.toString());
  printQuery.searchParams.set('print', '1');
  addCandidate(out, printQuery.toString(), 'url-variant', 'Common printable page variant.', 0.3);

  for (const migrated of knownMigrationCandidates(parsed)) {
    addCandidate(out, migrated, 'known-migration', 'Known public domain migration.', 0.95);
  }
  return dedupeCandidates(out);
}

function defaultArchiveRescueSearchQueries(rawUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(rawUrl);
  } catch {
    return [];
  }
  const host = normalizedHost(parsed.hostname);
  const slug = readablePathTokens(parsed.pathname);
  const queries = [
    `"${rawUrl}"`,
    `site:web.archive.org/web "${rawUrl}"`,
    `site:archive.today "${rawUrl}"`,
  ];
  if (slug) {
    queries.push(`"${slug}" "${host}"`);
    queries.push(`${slug} ${host}`);
  } else {
    queries.push(`"${host}" "${rawUrl}"`);
  }
  for (const query of scholarlySearchQueries(rawUrl)) queries.push(query);
  // No tweet-mirror searches: tweets are rebuilt via FixTweet (canonical x.com),
  // not by hunting for a live Nitter instance (the ecosystem is dead).
  return queries;
}

function searchResultCandidates(
  results: ArchiveRescueSearchResult[],
  originalUrl: string,
  query: string,
): ArchiveRescueCandidate[] {
  const out: ArchiveRescueCandidate[] = [];
  for (const result of results) {
    const urls = [result.url, ...extractUrls(`${result.title ?? ''} ${result.snippet ?? ''}`)];
    for (const url of urls) {
      if (!candidateAllowedForSource(url, originalUrl)) continue;
      const confidence = searchCandidateConfidence(url, originalUrl);
      addCandidate(
        out,
        url,
        'web-search',
        `Search result for ${truncateReason(query)}${result.title ? `: ${truncateReason(result.title)}` : ''}`,
        confidence,
      );
    }
  }
  return dedupeCandidates(out);
}

function searchCandidateConfidence(candidateUrl: string, originalUrl: string): number {
  try {
    const candidate = validateSafePublicHttpUrl(candidateUrl);
    const original = validateSafePublicHttpUrl(originalUrl);
    const candidateHost = normalizedHost(candidate.hostname);
    const originalHost = normalizedHost(original.hostname);
    if (isKnownArchiveCandidate(candidate)) return 0.88;
    if (isKnownMigrationPair(originalHost, candidateHost)) return 0.86;
    if (hostsAreRelated(originalHost, candidateHost)) return 0.68;
  } catch {
    return 0;
  }
  return 0.4;
}

function readablePathTokens(pathname: string): string {
  const decoded = safeDecodePath(pathname)
    .split('/')
    .filter(Boolean)
    .slice(-3)
    .join(' ')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return decoded.length > 120 ? decoded.slice(0, 120).trim() : decoded;
}

function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const re = /https?:\/\/[^\s"'<>),]+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && urls.length < 8) {
    urls.push(match[0].replace(/[.;\]]+$/, ''));
  }
  return urls;
}

function truncateReason(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 120);
}

async function waybackCandidates(
  rawUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  whenUnixSeconds?: number,
): Promise<ArchiveRescueCandidate[]> {
  // Bias toward the snapshot closest to when the user bookmarked the page (the
  // version they actually saw), not merely the most recent capture — which for
  // a dead/changed site is often a post-rot parking page.
  const ts = waybackTimestamp(whenUnixSeconds);
  const availabilityUrl =
    `https://archive.org/wayback/available?url=${encodeURIComponent(rawUrl)}${ts ? `&timestamp=${ts}` : ''}`;
  const res = await fetchImpl(availabilityUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json() as {
    archived_snapshots?: {
      closest?: {
        available?: boolean;
        status?: string;
        url?: string;
      };
    };
  };
  const closest = data.archived_snapshots?.closest;
  if (!closest?.available || !closest.url) return [];
  if (closest.status && !/^2\d\d$/.test(closest.status)) return [];
  return [{
    url: closest.url,
    source: 'wayback',
    reason: 'Wayback has an available public snapshot.',
    confidence: 0.9,
  }];
}

/** Wayback compact timestamp (YYYYMMDD) for the availability `timestamp=`
 *  param, or null when we have no bookmark time to anchor on. */
function waybackTimestamp(unixSeconds?: number): string | null {
  if (!unixSeconds || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * Direct archive.today probe — its `/newest/` timegate 30x-redirects to the
 * dated snapshot when one exists. archive.today often holds captures of
 * paywalled / bot-walled pages that Wayback misses (and is the practical
 * replacement for the now-dead Google Cache). No JSON API, so we read the
 * redirect; anything else (200 search page, 404, Cloudflare challenge) means
 * no usable snapshot. The verify pass still validates whatever we return.
 */
async function archiveTodayCandidates(
  rawUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ArchiveRescueCandidate[]> {
  try {
    const res = await fetchImpl(`https://archive.ph/newest/${rawUrl}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/html' },
    });
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location') ?? '';
    if (
      res.status >= 300 && res.status < 400 &&
      /^https?:\/\/archive\.(ph|today|is|li|vn|fo|md)\/\w+/i.test(location)
    ) {
      return [{
        url: location,
        source: 'wayback',
        reason: 'archive.today has a public snapshot.',
        confidence: 0.85,
      }];
    }
  } catch {
    // Best-effort: archive.today is frequently rate-limited / behind Cloudflare.
  }
  return [];
}

function knownMigrationCandidates(parsed: URL): string[] {
  const host = normalizedHost(parsed.hostname);
  if (host === 'gomix.com') {
    const migrated = new URL(parsed.toString());
    migrated.protocol = 'https:';
    migrated.hostname = 'glitch.com';
    return [migrated.toString()];
  }
  return [];
}

// ─── Tweets ──────────────────────────────────────────────────────────
// x.com / Twitter render content client-side and block scrapers, so a direct
// capture is an empty shell, and the public Nitter mirror ecosystem is dead
// (rate-limited / blocked / empty-200). The archive worker instead rebuilds a
// tweet from the FixTweet API by status id. So a tweet rescue is simply "point
// at the canonical x.com URL and let the worker rebuild it" — we surface that
// one candidate and verify it against FixTweet (verifyTweetViaFixTweet). No
// Nitter mirror is ever fetched or enqueued.
const TWITTER_FAMILY_HOSTS = new Set([
  'x.com', 'twitter.com', 'mobile.twitter.com', 'xcancel.com', 'nitter.net',
]);

function isTwitterFamilyHost(host: string): boolean {
  const normalized = normalizedHost(host);
  return TWITTER_FAMILY_HOSTS.has(normalized) || /(^|\.)nitter\./i.test(normalized);
}

function twitterStatusId(parsed: URL): string | null {
  const match = safeDecodePath(parsed.pathname).match(/\/status(?:es)?\/(\d{5,25})/i);
  return match ? match[1]! : null;
}

function tweetScreenName(parsed: URL): string {
  const match = safeDecodePath(parsed.pathname).match(/^\/([A-Za-z0-9_]{1,15})\/status/i);
  return match?.[1] ?? 'i';
}

/** Canonical x.com URL for a tweet on any twitter-family host (incl. Nitter),
 *  or null if it isn't a tweet. x.com is the only host the worker's FixTweet
 *  rebuild path recognizes, so every tweet rescue points here. */
function canonicalTweetUrl(parsed: URL): string | null {
  const id = twitterStatusId(parsed);
  if (!id) return null;
  return `https://x.com/${tweetScreenName(parsed)}/status/${id}`;
}

function socialMirrorCandidates(rawUrl: string): ArchiveRescueCandidate[] {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(rawUrl);
  } catch {
    return [];
  }
  if (!isTwitterFamilyHost(parsed.hostname)) return [];
  const canonical = canonicalTweetUrl(parsed);
  if (!canonical) return [];
  const out: ArchiveRescueCandidate[] = [];
  addCandidate(out, canonical, 'social-mirror', 'Canonical x.com tweet, rebuilt via the FixTweet API.', 0.9);
  return dedupeCandidates(out);
}

/** A candidate that rebuilds the SAME tweet as the original (any twitter-family
 *  host → canonical x.com via FixTweet). Same status id is required, so a
 *  different tweet — even one an LLM suggests — is never substituted. */
function isTweetRebuildCandidate(original: URL, candidate: URL): boolean {
  if (!isTwitterFamilyHost(original.hostname)) return false;
  const originalId = twitterStatusId(original);
  if (originalId === null) return false;
  return originalId === twitterStatusId(candidate);
}

/** The canonical x.com rebuild URL for a candidate that is a same-tweet rescue
 *  of the original, or null if it isn't one (then it takes the normal HTML
 *  verify path). */
function tweetRebuildCanonical(candidateUrl: string, originalUrl: string): string | null {
  let candidate: URL;
  let original: URL;
  try {
    candidate = validateSafePublicHttpUrl(candidateUrl);
    original = validateSafePublicHttpUrl(originalUrl);
  } catch {
    return null;
  }
  if (!isTweetRebuildCandidate(original, candidate)) return null;
  return canonicalTweetUrl(candidate);
}

/** Verify a tweet rescue by confirming the FixTweet API serves THIS tweet (the
 *  same check Box B's worker performs), then return the canonical x.com URL so
 *  the enqueued job hits the worker's FixTweet rebuild path. */
async function verifyTweetViaFixTweet(
  canonicalUrl: string,
  candidate: ArchiveRescueCandidate,
  fetchImpl: typeof fetch,
  options: ArchiveRescueOptions,
): Promise<VerifiedArchiveRescueCandidate | null> {
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return null;
  }
  const id = twitterStatusId(parsed);
  if (!id) return null;
  const screen = tweetScreenName(parsed);
  for (const base of FIXTWEET_PROVIDERS) {
    const res = await fetchImpl(`${base}/${screen}/status/${id}`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? VERIFY_TIMEOUT_MS),
      headers: { 'user-agent': FIXTWEET_USER_AGENT, accept: 'application/json' },
    }).catch(() => null);
    if (!res) continue;
    if (res.status < 200 || res.status >= 300) {
      void res.body?.cancel().catch(() => undefined);
      continue;
    }
    const text = await readBoundedText(res, VERIFY_BODY_LIMIT_BYTES).catch(() => '');
    let servedId: unknown;
    try {
      servedId = (JSON.parse(text) as { tweet?: { id?: unknown } })?.tweet?.id;
    } catch {
      continue;
    }
    // The provider must serve THIS tweet id — never a redirect to another.
    if (servedId != null && String(servedId) === id) {
      return { ...candidate, url: canonicalUrl, status: 200, contentType: 'text/html; charset=utf-8' };
    }
  }
  return null;
}

/** Read up to `maxBytes` of a response body as text (the candidate fetch
 *  already asks for a byte range, but a server may ignore it, so cap here). */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** For a tweet original, require a candidate page to actually be about this
 *  tweet before we archive it. This is what makes host-agnostic mirror
 *  discovery safe: a forged or unrelated page that happens to share the URL
 *  shape is dropped. Non-tweet originals are unaffected. */
function tweetMirrorContentOk(candidate: URL, originalUrl: string, body: string): boolean {
  let original: URL;
  try { original = validateSafePublicHttpUrl(originalUrl); } catch { return true; }
  if (!isTwitterFamilyHost(original.hostname)) return true;
  const statusId = twitterStatusId(original);
  if (!statusId) return true;
  const candidateId = twitterStatusId(candidate);
  // A candidate that looks like a tweet but carries a DIFFERENT status id is
  // the wrong tweet — reject it whatever the source (even an LLM suggestion),
  // so the LLM's flexibility can never archive the wrong tweet.
  if (candidateId !== null && candidateId !== statusId) return false;
  // A same-id mirror must actually contain the tweet (host-agnostic binding).
  if (candidateId === statusId) {
    return body.includes(statusId) && /twitter|x\.com|nitter|tweet/i.test(body);
  }
  // A non-tweet alternative (no status id — e.g. an article about it) is a
  // generic candidate; leave it to the source gate + the other content checks.
  return true;
}

function normalizeRescueCandidate(
  candidate: ArchiveRescueCandidate,
  originalUrl: string,
): ArchiveRescueCandidate | null {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(candidate.url);
  } catch {
    return null;
  }
  parsed.hash = '';
  const normalized = parsed.toString();
  if (!candidateAllowedForSource(normalized, originalUrl, candidate.source)) return null;
  return {
    ...candidate,
    url: normalized,
    reason: candidate.reason.slice(0, 240),
    confidence: clamp01(candidate.confidence),
  };
}

function candidateAllowedForSource(
  candidateUrl: string,
  originalUrl: string,
  source?: ArchiveRescueSource,
): boolean {
  let candidate: URL;
  let original: URL;
  try {
    candidate = validateSafePublicHttpUrl(candidateUrl);
    original = validateSafePublicHttpUrl(originalUrl);
  } catch {
    return false;
  }
  const candidateHost = normalizedHost(candidate.hostname);
  const originalHost = normalizedHost(original.hostname);
  if (isKnownArchiveCandidate(candidate)) return true;
  // A tweet rescue rebuilds the SAME tweet via the FixTweet API. The canonical
  // x.com candidate (or a same-id tweet URL an LLM / search surfaced) is
  // allowed; a different tweet id is not. Not source-gated.
  if (isTweetRebuildCandidate(original, candidate)) return true;
  // The LLM is our own reasoning agent, prompted to find a public copy of the
  // blocked page — trust it to range across hosts when a page genuinely can't
  // be captured from the source. The hard safety floor still applies at fetch
  // time (SSRF resolve + size + content-type + minimum-content), so a
  // hallucinated or dead URL fails to verify instead of archiving junk. Raw
  // web-search results stay host-constrained below — those are
  // attacker-influenceable (SEO), the LLM's reasoning is not.
  if (source === 'llm') return true;
  if (source === 'scholarly-pdf' && scholarlyPdfCandidateAllowed(original, candidate)) return true;
  if (isKnownMigrationPair(originalHost, candidateHost)) {
    return pathsAreRelated(original.pathname, candidate.pathname);
  }
  if (!hostsAreRelated(originalHost, candidateHost)) return false;
  return pathsAreRelated(original.pathname, candidate.pathname) ||
    scholarlySiblingCandidateAllowed(original, candidate);
}

function isKnownArchiveCandidate(candidate: URL): boolean {
  const host = normalizedHost(candidate.hostname);
  if (host === 'web.archive.org' || host === 'archive.org') {
    return candidate.pathname.startsWith('/web/');
  }
  return host === 'archive.today' ||
    host === 'archive.is' ||
    host === 'archive.ph' ||
    host === 'archive.vn' ||
    host === 'ghostarchive.org';
}

function isKnownMigrationPair(originalHost: string, candidateHost: string): boolean {
  return originalHost === 'gomix.com' && candidateHost === 'glitch.com';
}

function hostsAreRelated(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

async function scholarlyPdfCandidates(
  rawUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ candidates: ArchiveRescueCandidate[]; searchQueries: string[] }> {
  const identifiers = scholarlyIdentifiersFromUrl(rawUrl);
  if (!identifiers.pii && !identifiers.doi && !isScholarlyUrl(rawUrl)) {
    return { candidates: [], searchQueries: [] };
  }

  const out: ArchiveRescueCandidate[] = [];
  for (const url of deterministicScholarlyPdfUrls(rawUrl, identifiers)) {
    addCandidate(out, url, 'scholarly-pdf', 'Scholarly article PDF URL variant.', 0.78);
  }

  const metadataPdfUrls = await scholarlyMetadataPdfUrls(identifiers, fetchImpl, timeoutMs);
  for (const url of metadataPdfUrls) {
    addCandidate(out, url, 'scholarly-pdf', 'Public scholarly metadata provider exposed a PDF URL.', 0.9);
  }

  return {
    candidates: dedupeCandidates(out),
    searchQueries: scholarlySearchQueries(rawUrl),
  };
}

function deterministicScholarlyPdfUrls(
  rawUrl: string,
  identifiers: ScholarlyIdentifiers,
): string[] {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(rawUrl);
  } catch {
    return [];
  }

  const out: string[] = [];
  const host = normalizedHost(parsed.hostname);
  const pii = identifiers.pii;
  const add = (url: URL): void => {
    url.hash = '';
    out.push(url.toString());
  };

  if (pii) {
    const articlePdf = new URL(parsed.toString());
    const basePath = articlePdf.pathname.replace(/\/(?:fulltext|abstract|summary|pdf)\/?$/i, '');
    if (/\/article\/PII/i.test(basePath)) {
      articlePdf.pathname = `${basePath}/pdf`;
      articlePdf.search = '';
      add(articlePdf);
    }

    if (host.endsWith('thelancet.com') || host.endsWith('elsevier.com') || host.endsWith('sciencedirect.com')) {
      const showPdf = new URL(parsed.toString());
      showPdf.pathname = '/action/showPdf';
      showPdf.search = '';
      showPdf.searchParams.set('pii', pii);
      add(showPdf);
    }
  }

  return dedupeStrings(out, 8);
}

async function scholarlyMetadataPdfUrls(
  identifiers: ScholarlyIdentifiers,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string[]> {
  if (!identifiers.doi) return [];
  const urls: string[] = [];
  const doi = identifiers.doi;
  const providers = [
    `https://api.openalex.org/works/${encodeURIComponent(`https://doi.org/${doi}`)}`,
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
  ];
  for (const endpoint of providers) {
    const json = await fetchJsonCandidate(endpoint, fetchImpl, timeoutMs).catch(() => null);
    if (!json) continue;
    urls.push(...pdfUrlsFromScholarlyMetadata(json));
  }
  return dedupeStrings(urls, 8);
}

async function fetchJsonCandidate(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown | null> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'Deepmarks-Archive-Rescue/1.0 (+https://deepmarks.org/bot)',
    },
  });
  if (!res.ok) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < MAX_SCHOLARLY_METADATA_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_SCHOLARLY_METADATA_BYTES - received;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (value.byteLength > remaining) break;
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) as unknown;
}

function pdfUrlsFromScholarlyMetadata(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || out.length >= 12 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['pdf_url', 'url_for_pdf', 'URL', 'url']) {
      const raw = record[key];
      if (typeof raw === 'string' && looksLikePdfMetadataUrl(raw, record)) out.push(raw);
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return dedupeStrings(out, 12);
}

function looksLikePdfMetadataUrl(rawUrl: string, context: Record<string, unknown>): boolean {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(rawUrl);
  } catch {
    return false;
  }
  const contentType = String(
    context['content-type'] ?? context.content_type ?? context.mime ?? context.mime_type ?? '',
  ).toLowerCase();
  return contentType.includes('pdf') || isLikelyPdfUrl(parsed);
}

function scholarlySearchQueries(rawUrl: string): string[] {
  const identifiers = scholarlyIdentifiersFromUrl(rawUrl);
  const out: string[] = [];
  if (identifiers.pii) {
    out.push(`"${identifiers.pii}" filetype:pdf`);
    out.push(`"${identifiers.pii}" pdf`);
  }
  if (identifiers.doi) {
    out.push(`"${identifiers.doi}" filetype:pdf`);
    out.push(`"${identifiers.doi}" pdf`);
  }
  return dedupeStrings(out, 6);
}

interface ScholarlyIdentifiers {
  doi?: string;
  pii?: string;
}

function scholarlyIdentifiersFromUrl(rawUrl: string): ScholarlyIdentifiers {
  let parsed: URL;
  try {
    parsed = validateSafePublicHttpUrl(rawUrl);
  } catch {
    return {};
  }
  const pii = extractPiiFromUrl(parsed) ?? undefined;
  const doi = extractDoiFromUrl(parsed) ?? doiFromLancetPii(parsed, pii) ?? undefined;
  return { doi, pii };
}

function extractPiiFromUrl(parsed: URL): string | null {
  const fromQuery = parsed.searchParams.get('pii') ?? parsed.searchParams.get('PII');
  if (fromQuery) return normalizePii(fromQuery);
  const decodedPath = safeDecodePath(parsed.pathname);
  const match = decodedPath.match(/(?:^|\/)PII([^/?#]+)/i) ?? decodedPath.match(/(?:^|\/)pii\/([^/?#]+)/i);
  return normalizePii(match?.[1]);
}

function normalizePii(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^S[0-9A-Z().-]{8,}$/i.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

function extractDoiFromUrl(parsed: URL): string | null {
  const doiParam = parsed.searchParams.get('doi') ?? parsed.searchParams.get('DOI');
  const fromParam = normalizeDoi(doiParam);
  if (fromParam) return fromParam;
  const host = normalizedHost(parsed.hostname);
  const decodedPath = safeDecodePath(parsed.pathname).replace(/^\/+/, '');
  if (host === 'doi.org' || host === 'dx.doi.org') return normalizeDoi(decodedPath);
  const doiPathIndex = decodedPath.toLowerCase().indexOf('doi/');
  if (doiPathIndex >= 0) {
    const afterDoi = decodedPath.slice(doiPathIndex + 4);
    const parts = afterDoi.split('/').filter(Boolean);
    if (parts.length >= 3 && /^10\.\d{4,9}$/i.test(parts[0]!)) {
      return normalizeDoi(parts.slice(0, 3).join('/'));
    }
  }
  return normalizeDoi(decodedPath);
}

function doiFromLancetPii(parsed: URL, pii: string | undefined): string | null {
  if (!pii || !normalizedHost(parsed.hostname).endsWith('thelancet.com')) return null;
  return normalizeDoi(`10.1016/${pii}`);
}

function normalizeDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  const decoded = safeDecodePath(value).trim();
  const withoutUrlPrefix = decoded
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');
  const match = withoutUrlPrefix.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].replace(/[).,;:\]\s]+$/g, '').toLowerCase() : null;
}

function isScholarlyUrl(rawUrl: string): boolean {
  try {
    const parsed = validateSafePublicHttpUrl(rawUrl);
    const host = normalizedHost(parsed.hostname);
    return host === 'doi.org' ||
      host === 'dx.doi.org' ||
      host.includes('journal') ||
      host.endsWith('thelancet.com') ||
      host.endsWith('sciencedirect.com') ||
      host.endsWith('springer.com') ||
      host.endsWith('wiley.com') ||
      host.endsWith('oup.com') ||
      host.endsWith('nature.com') ||
      host.endsWith('pmc.ncbi.nlm.nih.gov') ||
      host.endsWith('pubmed.ncbi.nlm.nih.gov');
  } catch {
    return false;
  }
}

function scholarlyPdfCandidateAllowed(original: URL, candidate: URL): boolean {
  if (!isLikelyPdfUrl(candidate)) return false;
  const originalIds = scholarlyIdentifiersFromUrl(original.toString());
  if (!originalIds.doi && !originalIds.pii && !isScholarlyUrl(original.toString())) return false;
  const candidateIds = scholarlyIdentifiersFromUrl(candidate.toString());
  if (originalIds.pii && candidateIds.pii && originalIds.pii !== candidateIds.pii) return false;
  if (originalIds.doi && candidateIds.doi && originalIds.doi !== candidateIds.doi) return false;
  return true;
}

function scholarlySiblingCandidateAllowed(original: URL, candidate: URL): boolean {
  if (!isLikelyPdfUrl(candidate)) return false;
  const originalIds = scholarlyIdentifiersFromUrl(original.toString());
  const candidateIds = scholarlyIdentifiersFromUrl(candidate.toString());
  if (originalIds.pii && candidateIds.pii && originalIds.pii === candidateIds.pii) return true;
  if (originalIds.doi && candidateIds.doi && originalIds.doi === candidateIds.doi) return true;
  return false;
}

function isLikelyPdfUrl(url: URL): boolean {
  const path = safeDecodePath(url.pathname).toLowerCase();
  if (path.endsWith('.pdf') || path.includes('/pdf/') || path.endsWith('/pdf')) return true;
  if (/\/action\/showpdf$/i.test(path) && url.searchParams.has('pii')) return true;
  const accept = url.searchParams.get('download') ?? url.searchParams.get('format') ?? url.searchParams.get('type');
  return typeof accept === 'string' && /pdf/i.test(accept);
}

function pathsAreRelated(originalPath: string, candidatePath: string): boolean {
  const original = normalizedPath(originalPath);
  const candidate = normalizedPath(candidatePath);
  if (original === '/') return candidate === '/';
  return candidate === original || candidate.startsWith(`${original}/`);
}

function normalizedPath(pathname: string): string {
  const decoded = safeDecodePath(pathname)
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return decoded || '/';
}

function isRescuableContentType(contentType: string): boolean {
  return contentType.includes('text/html') ||
    contentType.includes('application/xhtml') ||
    contentType.includes('text/plain') ||
    contentType.includes('application/pdf') ||
    contentType.includes('application/xml') ||
    contentType.includes('text/xml') ||
    contentType.includes('application/rss') ||
    contentType.includes('application/atom');
}

async function listFailuresForRescue(
  redis: Redis,
  ownerPubkey: string | undefined,
  limit: number,
): Promise<ArchiveFailureRecord[]> {
  if (ownerPubkey) return (await listArchiveFailures(redis, ownerPubkey)).slice(0, limit);

  const failures: ArchiveFailureRecord[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${ARCHIVE_FAILURE_PREFIX}*`,
      'COUNT',
      100,
    );
    cursor = next;
    for (const key of keys) {
      const expectedOwner = key.slice(ARCHIVE_FAILURE_PREFIX.length);
      const raw = await redis.hgetall(key);
      for (const value of Object.values(raw ?? {})) {
        const parsed = parseArchiveFailureRecord(value, expectedOwner);
        if (parsed) failures.push(parsed);
      }
      if (failures.length >= limit) break;
    }
  } while (cursor !== '0' && failures.length < limit);

  failures.sort((a, b) => {
    const aTime = a.bookmarkSavedAt ?? a.failedAt;
    const bTime = b.bookmarkSavedAt ?? b.failedAt;
    if (aTime !== bTime) return bTime - aTime;
    return b.jobId.localeCompare(a.jobId);
  });
  return failures.slice(0, limit);
}

function toSummaryCandidate(candidate: ArchiveRescueCandidate): NonNullable<ArchiveFailureRescueSummary['candidates']>[number] {
  return {
    url: candidate.url,
    source: candidate.source,
    reason: candidate.reason,
    confidence: candidate.confidence,
  };
}

function toVerifiedSummaryCandidate(
  candidate: VerifiedArchiveRescueCandidate,
): NonNullable<ArchiveFailureRescueSummary['verifiedCandidates']>[number] {
  return {
    url: candidate.url,
    source: candidate.source,
    reason: candidate.reason,
    confidence: candidate.confidence,
    status: candidate.status,
    finalUrl: candidate.finalUrl,
    contentType: candidate.contentType,
  };
}

function addCandidate(
  out: ArchiveRescueCandidate[],
  url: string,
  source: ArchiveRescueSource,
  reason: string,
  confidence: number,
): void {
  out.push({ url, source, reason, confidence });
}

function dedupeCandidates(candidates: ArchiveRescueCandidate[]): ArchiveRescueCandidate[] {
  const byUrl = new Map<string, ArchiveRescueCandidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing || candidateRank(candidate) > candidateRank(existing)) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

function sortRescueCandidates<T extends ArchiveRescueCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => candidateRank(b) - candidateRank(a));
}

function candidateRank(candidate: ArchiveRescueCandidate): number {
  const priority = candidate.source === 'known-migration'
    ? 0.08
    : candidate.source === 'wayback'
      ? 0.06
      : candidate.source === 'llm'
        ? 0.04
        : 0;
  return clamp01(candidate.confidence) + priority;
}

function dedupeStrings(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value.slice(0, 200));
    if (out.length >= limit) break;
  }
  return out;
}

function archiveRescueJobId(originalJobId: string, rescueUrl: string): `rescue:${string}` {
  const hash = createHash('sha256').update(`${originalJobId}\n${rescueUrl}`).digest('hex').slice(0, 32);
  return `rescue:${hash}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
