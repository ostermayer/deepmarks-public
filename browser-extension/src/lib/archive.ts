// Archive flow.
//
// Path A — lifetime member: POST /archive/lifetime (NIP-98-gated).
//
// Lifetime status check: GET /account/lifetime/status?pubkey= — public
// read, no auth.

import { buildNip98AuthHeader } from './nip98.js';

const API_BASE = 'https://api.deepmarks.org';

export interface LifetimeStatus {
  pubkey: string;
  isLifetimeMember: boolean;
  paidAt: number | null;
}

export async function getLifetimeStatus(pubkey: string): Promise<LifetimeStatus> {
  const res = await fetch(`${API_BASE}/account/lifetime/status?pubkey=${encodeURIComponent(pubkey)}`);
  if (!res.ok) throw new Error(`lifetime status ${res.status}`);
  return (await res.json()) as LifetimeStatus;
}

export interface LifetimeCheckout {
  invoiceId: string;
  checkoutLink: string;  // hosted BTCPay page — both on-chain BTC and Lightning shown there
  amountSats: number;
  expiresAt: number;
}

/**
 * Mint a BTCPay checkout for the lifetime upgrade. The checkoutLink
 * is a hosted page that handles both on-chain BTC and Lightning;
 * extension UI typically opens it in a new tab. Once paid, the
 * webhook on Box A flips the user to lifetime; the extension polls
 * getLifetimeStatus to detect.
 */
export async function startLifetimeCheckout(nsecHex: string): Promise<LifetimeCheckout> {
  const path = '/account/lifetime';
  const url = `${API_BASE}${path}`;
  const body = JSON.stringify({
    // Server uses its own price; this only tells BTCPay where the paid
    // checkout return button should send the user.
    redirectUrl: 'https://deepmarks.org/app/bookmarks?upgraded=1',
  });
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (res.status === 409) throw new Error('already a lifetime member');
  if (!res.ok) throw new Error(`lifetime checkout ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as LifetimeCheckout;
}

export interface LifetimeArchiveResponse {
  paymentHash: string;
  jobId: string;
  amountSats: 0;
}

export interface MediaArchiveAddonStatus {
  purchased: boolean;
  paidAt: number | null;
  amountSats: number;
  lifetimeRequired?: boolean;
}

export async function getMediaArchiveAddonStatus(nsecHex: string): Promise<MediaArchiveAddonStatus> {
  const path = '/add-on/video-archive/status';
  const url = `${API_BASE}${path}`;
  const auth = await buildNip98AuthHeader(url, 'GET', nsecHex);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`media archive status ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as MediaArchiveAddonStatus;
}

export interface ArchiveRequestInput {
  url: string;
  eventId?: string;
  /** kind:39701 event id, optional — server links the archive to it. */
  /** When 'private', the worker AES-encrypts the rendered HTML with
   *  archiveKey before uploading to Blossom. Anyone with the blobHash
   *  can fetch the ciphertext but only the holder of archiveKey can
   *  decrypt. Default 'public'. */
  tier?: 'public' | 'private';
  /** Plaintext 32-byte AES-256 key, base64. Required when tier is
   *  'private'. The extension generates this fresh per archive (see
   *  lib/archive-keys.ts:generateArchiveKey) and immediately wraps a
   *  copy via NIP-44 self-encryption for local storage; the plaintext
   *  copy is what we send to the server (one-shot, zeroed by the
   *  worker after encryption). */
  archiveKey?: string;
  /** User-owned backup Blossom servers to add to operator mirrors. */
  mirrorUrls?: string[];
  /** Background/default archive requests can dedupe near-simultaneous
   *  enqueue attempts. Explicit user retries should leave this false. */
  dedupe?: boolean;
}

/**
 * Lifetime path. Returns a synthetic payment hash + job id so the
 * caller can poll status.
 * Throws if the auth pubkey isn't a lifetime member.
 */
export async function startLifetimeArchive(
  input: ArchiveRequestInput,
  nsecHex: string,
): Promise<LifetimeArchiveResponse> {
  const path = '/archive/lifetime';
  const url = `${API_BASE}${path}`;
  const body = JSON.stringify(input);
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (res.status === 402) throw new Error('lifetime membership required to archive pages');
  if (!res.ok) throw new Error(`lifetime archive ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as LifetimeArchiveResponse;
}

export interface BrowserCaptureArchiveInput {
  url: string;
  eventId?: string;
  archiveKey: string;
  htmlBase64: string;
  title?: string;
  mirrorUrls?: string[];
  bookmarkSavedAt?: number;
}

/** Queue a private archive from HTML captured in the user's active tab.
 * Used as an explicit fallback for pages that block the server worker
 * but are visible to the user in their own browser session. */
export async function startBrowserCaptureArchive(
  input: BrowserCaptureArchiveInput,
  nsecHex: string,
): Promise<LifetimeArchiveResponse> {
  const path = '/archive/browser-capture';
  const url = `${API_BASE}${path}`;
  const body = JSON.stringify(input);
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (res.status === 402) throw new Error('lifetime membership required to archive pages');
  if (!res.ok) throw new Error(`browser capture archive ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as LifetimeArchiveResponse;
}

export interface MediaArchiveRequestInput {
  url: string;
  archiveKey: string;
  eventId?: string;
  bookmarkSavedAt?: number;
}

export async function startMediaArchive(
  input: MediaArchiveRequestInput,
  nsecHex: string,
): Promise<LifetimeArchiveResponse & { canonicalUrl: string; videoId?: string; videoContentKey?: string }> {
  const path = '/add-on/video-archive/enqueue';
  const url = `${API_BASE}${path}`;
  const body = JSON.stringify(input);
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (res.status === 402) throw new Error('media archive add-on required');
  if (!res.ok) throw new Error(`media archive ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as LifetimeArchiveResponse & { canonicalUrl: string; videoId?: string; videoContentKey?: string };
}

export type ArchiveStatusState =
  | 'pending-payment'
  | 'paid'
  | 'queued'
  | 'enqueued'
  | 'archiving'
  | 'mirroring'
  | 'done'
  | 'archived'
  | 'failed'
  | 'expired';

export interface ArchiveStatus {
  status: ArchiveStatusState;
  state?: 'pending-payment' | 'queued' | 'archiving' | 'mirroring' | 'done' | 'failed';
  paidAt?: number;
  amountSats?: number;
  url?: string;
  blobHash?: string;
  blossomHash?: string;
  error?: string;
}

export async function archiveStatus(paymentHash: string): Promise<ArchiveStatus> {
  const res = await fetch(`${API_BASE}/archive/status/${encodeURIComponent(paymentHash)}`);
  if (!res.ok) throw new Error(`archive status ${res.status}`);
  return (await res.json()) as ArchiveStatus;
}

export interface ArchiveRecord {
  jobId: string;
  url: string;
  blobHash: string;
  /** 'public' | 'private' — public is the bare HTML; private is
   *  AES-GCM ciphertext that the client must decrypt locally. */
  tier: string;
  source?: string;
  archivedAt: number;
  contentType?: string;
  fileName?: string;
  kind?: 'webpage' | 'youtube' | 'video' | 'media' | 'file' | string;
  videoId?: string;
  videoContentKey?: string;
  /** Viewport-screenshot blob hash, public-tier only. UI fetches via
   *  <img src=https://blossom.deepmarks.org/<thumbHash>>. Optional —
   *  old archives predate the screenshot pipeline, and private
   *  archives intentionally skip the upload (the screenshot bytes
   *  would leak page content the encrypted main archive hides). */
  thumbHash?: string;
}

export async function listAllMyArchives(nsecHex: string): Promise<ArchiveRecord[]> {
  const all: ArchiveRecord[] = [];
  const limit = 500;
  for (let offset = 0; offset <= 10_000; offset += limit) {
    const path = '/account/archives';
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const signedUrl = `${API_BASE}${path}`;
    const requestUrl = `${signedUrl}?${qs.toString()}`;
    const auth = await buildNip98AuthHeader(signedUrl, 'GET', nsecHex);
    const res = await fetch(requestUrl, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`list archives ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { archives: ArchiveRecord[]; count?: number; total?: number };
    all.push(...(json.archives ?? []));
    const count = typeof json.count === 'number' ? json.count : json.archives?.length ?? 0;
    const total = typeof json.total === 'number' ? json.total : all.length;
    if (count === 0 || all.length >= total) break;
  }
  return all;
}

/** Build a public viewing URL for an archive blob. Public-tier archives
 *  open as plain HTML; private-tier are ciphertext and need client-side
 *  decryption (Phase 2 of the archives view; not yet wired). */
export function archiveViewUrl(blobHash: string): string {
  return `https://blossom.deepmarks.org/${encodeURIComponent(blobHash)}`;
}

export interface ArchiveDeleteResponse {
  ok: true;
  blobHash: string;
  url?: string;
  tier?: string;
  /** True when our primary's S3 deleteObject succeeded; false when
   *  S3 access was unavailable or the operation errored. The user-list
   *  cleanup happens regardless so the UI is always consistent. */
  primaryDeleted: boolean;
  primaryError?: string;
  /** Always true today — we have no mechanism to instruct mirror
   *  operators to drop a blob. Kept as a flag for future BUD-01
   *  DELETE fanout if mirrors ever honor third-party deletes. */
  mirrorsRetained: boolean;
  mirrorNote: string;
}

/** Delete an archive from the user's account: drops the entry from
 *  dm:archives:<pubkey> and asks our primary to remove the S3 object.
 *  Mirrors are out of reach (see mirrorNote in the response). For
 *  private archives the caller should ALSO purge the archive key from
 *  their NIP-51 set + chrome.storage.local cache so mirror copies
 *  remain mathematically unreadable. */
export async function deleteArchive(blobHash: string, nsecHex: string): Promise<ArchiveDeleteResponse> {
  const path = `/account/archives/${encodeURIComponent(blobHash)}`;
  const url = `${API_BASE}${path}`;
  const auth = await buildNip98AuthHeader(url, 'DELETE', nsecHex);
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`delete archive ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as ArchiveDeleteResponse;
}

