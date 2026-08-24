// ═══════════════════════════════════════════════════════════════════════
// CANONICAL SOURCE — packages/archive-wire/archive-wire.ts
//
// The Box A ⇄ Box B archive wire contract: shapes serialized whole into
// Redis and parsed by the other side. The api enqueues ArchiveJob JSON
// onto dm:archive:queue and ArchiveDeleteJob JSON onto
// dm:archive:delete:queue; the worker consumes both and embeds
// ArchiveFileRecord arrays in its callback payloads and done records.
// These interfaces were declared independently in api/src/types.ts and
// archive-worker/src/queue.ts and had already drifted once — the worker
// copy was missing `eventId`, and an earlier jobId-shape drift produced
// the `dm:archive:done:undefined` incident (2026-08-23 review,
// simplification backlog).
//
// Edit THIS file, then run:  node scripts/sync-shared-modules.mjs
// which regenerates the checked-in copies at api/src/archive-wire.ts and
// archive-worker/src/archive-wire.ts (each package's Docker build context
// only contains its own directory, so a runtime workspace dependency
// can't reach the images — generated copies + parity tests give one
// source of truth without touching the build system). A parity test in
// each suite fails if a copy drifts from this file.
//
// Deliberately NOT here:
//   - The /archive/callback payload — the api's zod ArchiveCallbackSchema
//     (api/src/routes/archive.ts) is the runtime authority; the worker
//     builds it ad hoc and the api validates every field on receipt.
//   - DoneRecord (archive-worker/src/queue.ts) — worker-internal; the
//     api reads dm:archive:done:* defensively with partial casts.
//   - ArchiveJobMetadata (api/src/types.ts) — an api-internal projection
//     of ArchiveJob (derived from it via Pick, so it can't drift).
// ═══════════════════════════════════════════════════════════════════════

/** On-the-wire job shape pushed onto dm:archive:queue by the api and
 *  BLMOVEd by the worker. Requeues reserialize the parsed object whole,
 *  so api-written fields survive worker restarts even when the worker
 *  never reads them. */
export interface ArchiveJob {
  /** Identity used by the worker callback path. We use paymentHash
   *  verbatim — it's already unique per archive job and lets the
   *  proxy correlate the callback back to a refund without an extra
   *  lookup table. */
  jobId: string;
  paymentHash: string;
  /** Renamed from userPubkey to match the worker's vocabulary. */
  ownerPubkey: string;
  url: string;
  /** Nostr event id (64 hex) of the bookmark this archive belongs to.
   *  Written by the api at enqueue and read back from the api's own
   *  30-day job metadata at callback time — the worker treats it as
   *  opaque passthrough. */
  eventId?: string;
  /** Default 'public' if the caller didn't specify. */
  tier: 'public' | 'private';
  /** Base64 AES-256 key (32 bytes). Null for public-tier jobs. */
  archiveKey: string | null;
  /** User-requested backup Blossom servers, merged with operator
   *  defaults by the worker after DNS/SSRF checks. */
  mirrorUrls?: string[];
  /** Retry counter, 0 on first enqueue. The worker increments on requeue. */
  attempts: number;
  /** When this job was first put on the queue (unix seconds). */
  enqueuedAt: number;
  /** Original bookmark save time, unix seconds. Forwarded through the
   *  worker callback so archive records keep bookmark ordering even
   *  when the archive completes much later. */
  bookmarkSavedAt?: number;
  /** Original bookmark URL when this job archives a public rescue URL. */
  originalUrl?: string;
  /** Job category. Default 'webpage' for the existing Playwright/SingleFile
   *  archive path. 'media'/'video' (and legacy 'youtube') triggers the yt-dlp
   *  branch, which downloads primary video/audio content, encrypts
   *  with AES-256-GCM (always private), and uploads to the ciphertext
   *  bucket rather than the public Blossom server. */
  kind?: 'webpage' | 'youtube' | 'video' | 'media' | 'file';
  /** YouTube video ID (11-char base64-URL alphabet) when the source URL
   *  can be canonicalized to a YouTube video. */
  videoId?: string;
  /** Stable source key forwarded to the archive callback. */
  videoContentKey?: string;
  /** Private browser-view capture payload. When present, the worker
   *  archives these already-captured HTML bytes instead of fetching the
   *  live URL. Omitted from retained job metadata so large DOM snapshots
   *  do not live in Redis for 30 days. */
  capturedHtmlBase64?: string;
  capturedTitle?: string;
  capturedContentType?: string;
  capturedAt?: number;
  captureSource?: 'browser-extension';
}

/** One stored file of a logical archive (an HTML snapshot, its sibling
 *  publisher PDF, a media download). Built by the worker, embedded in
 *  callback payloads and done records, persisted inside the api's
 *  archive records. */
export interface ArchiveFileRecord {
  role: 'html' | 'pdf' | 'file' | 'media';
  blobHash: string;
  url: string;
  source?: 'wayback' | 'rendered' | 'file';
  contentType?: string;
  fileName?: string;
  thumbHash?: string;
  mirrors?: Array<{ url: string; ok: boolean; error?: string }>;
}

/** Best-effort BUD-01 DELETE work item pushed onto dm:archive:delete:queue
 *  by the api after a user deletes one archive or tombstones their
 *  account; the worker fans the delete out to known mirror copies. */
export interface ArchiveDeleteJob {
  ownerPubkey: string;
  blobHash: string;
  mirrorUrls: string[];
  reason: 'archive-delete' | 'account-delete';
  requestedAt: number;
  url?: string;
  jobId?: string;
  attempt?: number;
}
