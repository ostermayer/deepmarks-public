// Nostr publish + read layer.
//
// We don't talk to api.deepmarks.org for bookmark CRUD — saving = sign
// + publish to the user's relays directly via SimplePool. Reading =
// subscribe to the same relays for kind:39701 events authored by the
// user. Pure protocol; no Deepmarks-specific server needed.
//
// Event shape matches the deployed web app's parseBookmarkEvent (see
// frontend/src/lib/nostr/bookmarks.ts) so a bookmark saved via the
// extension renders in the web app feed unchanged.

import { SimplePool, finalizeEvent, type EventTemplate, type Event as NostrEvent } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { getReadRelays, getWriteRelays } from './settings-store.js';

// kind:39701 — NIP-B0 web bookmark, parameterized replaceable on the
// `d` tag (which we set to the bookmark URL).
export const KIND_BOOKMARK = 39701;

export interface BookmarkInput {
  url: string;
  title: string;
  description?: string;
  tags: string[];
  /** Set when the user paid for a permanent archive — the worker's
   *  Blossom hash. Maps to the `blossom` tag. */
  blossomHash?: string;
  /** Set when archived. Maps to the `archive-tier` tag with value
   *  'forever'. */
  archivedForever?: boolean;
}

export interface PublishFailure {
  url: string;
  /** Relay's OK-false message, or 'timeout', or the JS error
   *  message from the WebSocket layer. Surfaced verbatim in the
   *  Saved screen so the user can see WHY a relay rejected. */
  reason: string;
}

export interface PublishResult {
  event: NostrEvent;
  ok: string[];               // relay URLs that accepted
  failed: PublishFailure[];   // relay URLs that rejected, with reason
}

/** Reject anything that isn't a plain http(s) URL — protects relays
 *  (and downstream readers) from publishable javascript:/data:/file:
 *  URLs that could be rendered by lax clients. The web app's reader
 *  filters these on read, but rejecting at write keeps the relays
 *  clean and surfaces the error to the user immediately instead of
 *  silently dropping. */
export function assertSafeBookmarkUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be bookmarked');
  }
}

// NIP-89 client identification — keep in sync with frontend's
// buildBookmarkEvent. Pointing at a kind:31990 handler info event
// under the brand pubkey lets other clients deep-link unknown
// kind:39701 events back to deepmarks.org/preview.
const NIP89_CLIENT_TAG: string[] = [
  'client',
  'Deepmarks',
  '31990:7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800:deepmarks',
];

/** Build the unsigned kind:39701 template that matches the web app. */
export function buildBookmarkTemplate(input: BookmarkInput): EventTemplate {
  assertSafeBookmarkUrl(input.url);
  const tags: string[][] = [
    ['d', input.url],
    ['title', input.title],
  ];
  if (input.description) tags.push(['description', input.description]);
  for (const t of input.tags) tags.push(['t', t]);
  if (input.blossomHash) tags.push(['blossom', input.blossomHash]);
  if (input.archivedForever) tags.push(['archive-tier', 'forever']);
  tags.push(NIP89_CLIENT_TAG);
  return {
    kind: KIND_BOOKMARK,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/** Sign + publish to every write-enabled relay in parallel. Resolves
 *  once each relay has either acked or hit the per-relay timeout.
 *
 *  Timeout is 8s — first-publish to a fresh relay incurs a WebSocket
 *  TLS handshake + protocol negotiation round-trip; 5s was tight when
 *  one of the relays was slow to accept. Failures carry the relay's
 *  actual rejection reason so the UI can show 'pow-required' or
 *  'rate-limited' rather than just 'didn't accept'. */
export async function publishBookmark(
  input: BookmarkInput,
  nsecHex: string,
  pool: SimplePool = sharedPool(),
  timeoutMs = 8000,
): Promise<PublishResult> {
  const sk = hexToBytes(nsecHex);
  const event = finalizeEvent(buildBookmarkTemplate(input), sk);
  const relays = await getWriteRelays();
  const results = await Promise.allSettled(
    relays.map((url) => withTimeout(pool.publish([url], event)[0], timeoutMs, url)),
  );
  const ok: string[] = [];
  const failed: PublishFailure[] = [];
  results.forEach((r, i) => {
    const url = relays[i]!;
    if (r.status === 'fulfilled') ok.push(url);
    else failed.push({ url, reason: extractFailReason(r.reason) });
  });
  return { event, ok, failed };
}

/** Pull a human-readable reason out of whatever the publish promise
 *  rejected with. nostr-tools throws strings like "msg: <relay-text>"
 *  on OK-false, Error instances on socket-level failures, and our own
 *  withTimeout fires "timeout: <url>". Normalize all three. */
export function extractFailReason(err: unknown): string {
  if (err == null) return 'unknown';
  if (typeof err === 'string') {
    if (err.startsWith('timeout:')) return 'timeout (relay too slow to respond)';
    return err;
  }
  if (err instanceof Error) {
    if (err.message.startsWith('timeout:')) return 'timeout (relay too slow to respond)';
    return err.message || 'unknown error';
  }
  try { return JSON.stringify(err); } catch { return 'unknown'; }
}

// NIP-09 deletion event. Tags reference the events being deleted via
// `e` for non-replaceable events and `a` for parameterized replaceable.
// kind:39701 (web bookmark) is the latter — addressable as
// `<kind>:<pubkey>:<d-tag>` so the `a` tag is the durable target. We
// include both `e` (the specific event id) and `a` (the address) so
// relays that only honor one form still drop the bookmark.
export const KIND_DELETION = 5;

/**
 * Publish a deletion request for one of the user's own bookmarks.
 * Per NIP-09, relays MAY drop the referenced event(s); not all do, and
 * any that have already replicated the event to other peers won't get
 * those copies removed. The bookmark will disappear from compliant
 * relays' query results. The UI optimistically removes the row.
 */
export async function deleteBookmark(
  eventId: string,
  url: string,
  ownerPubkey: string,
  nsecHex: string,
  pool: SimplePool = sharedPool(),
  timeoutMs = 8000,
): Promise<PublishResult> {
  const sk = hexToBytes(nsecHex);
  const template: EventTemplate = {
    kind: KIND_DELETION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', eventId],
      // a-tag for parameterized replaceable: kind:pubkey:d
      ['a', `${KIND_BOOKMARK}:${ownerPubkey}:${url}`],
      ['k', String(KIND_BOOKMARK)],
    ],
    content: '',
  };
  const event = finalizeEvent(template, sk);
  const relays = await getWriteRelays();
  const results = await Promise.allSettled(
    relays.map((u) => withTimeout(pool.publish([u], event)[0], timeoutMs, u)),
  );
  const ok: string[] = [];
  const failed: PublishFailure[] = [];
  results.forEach((r, i) => {
    const url = relays[i]!;
    if (r.status === 'fulfilled') ok.push(url);
    else failed.push({ url, reason: extractFailReason(r.reason) });
  });
  return { event, ok, failed };
}

// kind:0 — NIP-01 profile metadata. content is JSON with name, about,
// picture, display_name, lud16, nip05, banner, website.
export const KIND_PROFILE = 0;

export interface ParsedProfile {
  pubkey: string;
  name?: string;
  displayName?: string;
  picture?: string;
  about?: string;
}

// kind:10002 — NIP-65 relay list metadata. Tags are ["r", url, marker?]
// where marker is 'read', 'write', or absent (= both).
export const KIND_RELAY_LIST = 10002;

export interface ImportedRelay {
  url: string;
  read: boolean;
  write: boolean;
}

/** Fetch the user's NIP-65 relay list. Used at sign-in time so users
 *  with an existing Nostr identity see their familiar relays in the
 *  extension's settings instead of having to re-add them by hand.
 *  Queries the boot relays we ship with (Damus / Nos.lol / Primal /
 *  ours) — the user's relay list is replicated across many relays per
 *  NIP-65, so any one of these is enough for a hit. Returns [] if no
 *  kind:10002 has ever been published. */
export async function fetchUserRelayList(
  pubkey: string,
  pool: SimplePool = sharedPool(),
  bootRelays: string[] = [
    'wss://relay.deepmarks.org',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
  ],
  timeoutMs = 4000,
): Promise<ImportedRelay[]> {
  const events = await pool.querySync(
    bootRelays,
    { kinds: [KIND_RELAY_LIST], authors: [pubkey], limit: 1 },
    { maxWait: timeoutMs },
  ).catch(() => [] as NostrEvent[]);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return [];
  const out: ImportedRelay[] = [];
  for (const tag of latest.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string') continue;
    const url = tag[1].trim();
    if (!/^wss?:\/\//.test(url)) continue;  // skip malformed
    const marker = (tag[2] ?? '').toLowerCase();
    out.push({
      url,
      read: marker === '' || marker === 'read',
      write: marker === '' || marker === 'write',
    });
  }
  return out;
}

/** Fetch a single user's profile (kind:0) from the user's read relays
 *  AND the default boot set in parallel. Most users publish kind:0 to
 *  Damus / Nos.lol / Primal whether or not those are in their
 *  configured read list, so widening the net dramatically improves
 *  the "I have an avatar elsewhere but the extension shows the
 *  fallback" case.
 *
 *  Replaceable kind — we keep the latest by created_at across all
 *  relays. Result is cached in chrome.storage.local for 6 hours so
 *  popup-open doesn't refetch on every open; pass `force: true` to
 *  bypass after the user updates their picture.
 *
 *  Picture URL is filtered to http(s) only — kind:0 content comes
 *  from any relay so we treat it as untrusted. */
const PROFILE_CACHE_KEY = 'deepmarks-profile-cache';
const PROFILE_CACHE_TTL_SECONDS = 6 * 60 * 60;
const PROFILE_BOOT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.deepmarks.org',
];

interface CachedProfile {
  profile: ParsedProfile | null;
  fetchedAt: number;
}

async function readProfileCache(pubkey: string): Promise<ParsedProfile | null | undefined> {
  try {
    const raw = await chrome.storage.local.get(PROFILE_CACHE_KEY);
    const map = raw[PROFILE_CACHE_KEY] as Record<string, CachedProfile> | undefined;
    const hit = map?.[pubkey];
    if (!hit) return undefined;
    if (Date.now() / 1000 - hit.fetchedAt > PROFILE_CACHE_TTL_SECONDS) return undefined;
    return hit.profile;
  } catch {
    return undefined;
  }
}

async function writeProfileCache(pubkey: string, profile: ParsedProfile | null): Promise<void> {
  try {
    const raw = await chrome.storage.local.get(PROFILE_CACHE_KEY);
    const map = (raw[PROFILE_CACHE_KEY] as Record<string, CachedProfile> | undefined) ?? {};
    map[pubkey] = { profile, fetchedAt: Math.floor(Date.now() / 1000) };
    await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: map });
  } catch {
    // Quota / private mode — tolerable, we'll just refetch next time.
  }
}

export async function fetchProfile(
  pubkey: string,
  pool: SimplePool = sharedPool(),
  timeoutMs = 4000,
  opts: { force?: boolean } = {},
): Promise<ParsedProfile | null> {
  if (!opts.force) {
    const cached = await readProfileCache(pubkey);
    if (cached !== undefined) return cached;
  }
  const userRelays = await getReadRelays();
  // Union with boot relays. Set-dedup so a user whose read list
  // already includes Damus doesn't get queried twice.
  const relays = Array.from(new Set([...userRelays, ...PROFILE_BOOT_RELAYS]));
  if (relays.length === 0) return null;
  const events = await pool.querySync(
    relays,
    { kinds: [KIND_PROFILE], authors: [pubkey], limit: 1 },
    { maxWait: timeoutMs },
  ).catch(() => [] as NostrEvent[]);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) {
    await writeProfileCache(pubkey, null);
    return null;
  }
  let parsed: { name?: unknown; display_name?: unknown; picture?: unknown; about?: unknown };
  try { parsed = JSON.parse(latest.content); }
  catch {
    const empty = { pubkey };
    await writeProfileCache(pubkey, empty);
    return empty;
  }
  const safeUrl = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string' || !raw) return undefined;
    try {
      const u = new URL(raw);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? raw : undefined;
    } catch { return undefined; }
  };
  const profile: ParsedProfile = {
    pubkey,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    displayName: typeof parsed.display_name === 'string' ? parsed.display_name : undefined,
    picture: safeUrl(parsed.picture),
    about: typeof parsed.about === 'string' ? parsed.about : undefined,
  };
  await writeProfileCache(pubkey, profile);
  return profile;
}

/** Read recent bookmarks for one or more authors, newest first.
 *  Returns whatever lands within the timeout — no infinite stream. */
export async function fetchBookmarks(
  authors: string[],
  limit = 50,
  pool: SimplePool = sharedPool(),
  timeoutMs = 4000,
): Promise<NostrEvent[]> {
  const relays = await getReadRelays();
  if (relays.length === 0 || authors.length === 0) return [];
  const events = await pool.querySync(
    relays,
    { kinds: [KIND_BOOKMARK], authors, limit },
    { maxWait: timeoutMs },
  );
  // Dedup by `d` tag (URL) — kind:39701 is parameterized-replaceable
  // so the latest event wins. Sort newest first.
  const byUrl = new Map<string, NostrEvent>();
  for (const e of events) {
    const url = e.tags.find((t) => t[0] === 'd')?.[1];
    if (!url) continue;
    const prev = byUrl.get(url);
    if (!prev || prev.created_at < e.created_at) byUrl.set(url, e);
  }
  return [...byUrl.values()].sort((a, b) => b.created_at - a.created_at);
}

// ── Shared SimplePool ────────────────────────────────────────────────
// One pool per service-worker / popup lifetime. SimplePool maintains
// open WebSocket connections internally so callers don't pay the
// reconnect cost on every publish.

let _pool: SimplePool | null = null;
export function sharedPool(): SimplePool {
  if (!_pool) _pool = new SimplePool();
  return _pool;
}

// ── Helpers ──────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms),
    ),
  ]);
}
