// Archive flow.
//
// Path A — lifetime member: POST /archive/lifetime (NIP-98-gated, free).
// Path B — free user:       POST /archive/purchase (NIP-98-gated, returns
//                            a BOLT-11 invoice; user pays with their wallet;
//                            extension polls /archive/status/:hash).
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
  const body = JSON.stringify({});  // server uses its own price, ignores body
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

export interface ArchivePurchaseResponse {
  paymentHash: string;
  invoice: string;        // BOLT-11
  amountSats: number;
  expiresInSeconds: number;
}

export interface LifetimeArchiveResponse {
  paymentHash: string;
  jobId: string;
  amountSats: 0;
}

export interface ArchivePurchaseInput {
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
}

/**
 * Lifetime path: free archive. Returns a synthetic payment hash + job
 * id so the caller can poll status the same way as the paid flow.
 * Throws if the auth pubkey isn't a lifetime member.
 */
export async function startLifetimeArchive(
  input: ArchivePurchaseInput,
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
  if (res.status === 402) throw new Error('not a lifetime member — pay per archive instead');
  if (!res.ok) throw new Error(`lifetime archive ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as LifetimeArchiveResponse;
}

/**
 * Paid path: get an invoice. Caller renders QR + copy + lightning:
 * URL; user pays; caller polls archiveStatus(paymentHash) until it
 * flips to enqueued/archived.
 */
export async function startArchivePurchase(
  input: ArchivePurchaseInput & { userPubkey: string },
  nsecHex: string,
): Promise<ArchivePurchaseResponse> {
  const path = '/archive/purchase';
  const url = `${API_BASE}${path}`;
  const body = JSON.stringify(input);
  const auth = await buildNip98AuthHeader(url, 'POST', nsecHex, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body,
  });
  if (!res.ok) throw new Error(`archive purchase ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as ArchivePurchaseResponse;
}

export type ArchiveStatusState =
  | 'pending-payment'
  | 'paid'
  | 'enqueued'
  | 'archiving'
  | 'archived'
  | 'failed'
  | 'expired';

export interface ArchiveStatus {
  status: ArchiveStatusState;
  paidAt?: number;
  amountSats?: number;
  url?: string;
  blobHash?: string;
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
  /** Viewport-screenshot blob hash, public-tier only. UI fetches via
   *  <img src=https://blossom.deepmarks.org/<thumbHash>>. Optional —
   *  old archives predate the screenshot pipeline, and private
   *  archives intentionally skip the upload (the screenshot bytes
   *  would leak page content the encrypted main archive hides). */
  thumbHash?: string;
}

/** List the user's shipped archives — both rendered (paid) and lifetime
 *  (free) — newest first. NIP-98 auth so any nsec holder can list their
 *  own; the lifetime-only Bearer path at /api/v1/archives is the same
 *  data shape, just for script users. */
export async function listMyArchives(nsecHex: string): Promise<ArchiveRecord[]> {
  const path = '/account/archives';
  const url = `${API_BASE}${path}`;
  const auth = await buildNip98AuthHeader(url, 'GET', nsecHex);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`list archives ${res.status}: ${await res.text().catch(() => '')}`);
  const json = (await res.json()) as { archives: ArchiveRecord[] };
  return json.archives;
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

/**
 * Convenience: poll status until terminal or until `signal` aborts.
 * Yields each new status so callers can update progress UI.
 */
export async function* watchArchive(
  paymentHash: string,
  signal: AbortSignal,
  intervalMs = 2000,
): AsyncGenerator<ArchiveStatus> {
  while (!signal.aborted) {
    let s: ArchiveStatus;
    try {
      s = await archiveStatus(paymentHash);
    } catch {
      // Transient error — back off and retry.
      await sleep(intervalMs);
      continue;
    }
    yield s;
    if (s.status === 'archived' || s.status === 'failed' || s.status === 'expired') return;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
