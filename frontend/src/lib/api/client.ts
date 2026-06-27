// Thin wrapper around api + metadata HTTP endpoints.
// Frontend never holds long-lived credentials; auth is per-call via the
// caller's signer (or a short-lived JWT for email-linked sessions).
//
// Validate at boundaries. Every response is parsed through a zod schema
// so a misbehaving backend cannot poison the UI with garbage.

import { z } from 'zod';
import { config } from '$lib/config.js';

// ── Response schemas ────────────────────────────────────────────────────────

const UrlMetadataSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  favicon: z.string().optional(),
  lightning: z.string().optional(),
  mediaKind: z.enum(['image', 'video', 'audio']).optional(),
  contentType: z.string().optional(),
  pdfUrl: z.string().optional(),
  // Backend always emits an array (possibly empty). Kept as optional on the
  // type so z.infer stays consistent with the "no defaults" convention
  // above — callers should coalesce with `?? []` when reading.
  suggestedTags: z.array(z.string()).optional()
});

const PopularTagsResponseSchema = z.object({
  url: z.string(),
  tags: z.array(z.string()),
});

const LifetimeArchiveResponseSchema = z.object({
  paymentHash: z.string(),
  jobId: z.string(),
  amountSats: z.literal(0),
});

const ArchiveStatusSchema = z.object({
  jobId: z.string(),
  state: z.enum(['pending-payment', 'queued', 'archiving', 'mirroring', 'done', 'failed']),
  blossomHash: z.string().optional(),
  waybackUrl: z.string().optional(),
  files: z.array(z.object({
    role: z.enum(['html', 'pdf', 'file', 'media']),
    blobHash: z.string(),
    url: z.string(),
    source: z.enum(['wayback', 'rendered', 'file']).optional(),
    contentType: z.string().optional(),
    fileName: z.string().optional(),
    thumbHash: z.string().optional(),
    mirrors: z.array(z.object({
      url: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
    })).optional(),
  })).optional(),
  mirrors: z.array(z.object({ server: z.string(), ok: z.boolean() })).optional(),
  reason: z.enum(['site-blocked', 'not-found', 'timeout', 'failed']).optional(),
  message: z.string().optional(),
  error: z.string().optional()
});

const SearchHitSchema = z.object({
  eventId: z.string(),
  pubkey: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  saves: z.number(),
  sats: z.number()
});

const SearchPublicResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
  total: z.number()
});

const SemanticSearchDocSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  author_pubkey: z.string(),
  author_name: z.string().optional(),
  domain: z.string(),
  llm_summary: z.string().optional(),
  llm_tags: z.array(z.string()).optional(),
  llm_category: z.string().optional(),
  llm_language: z.string().optional(),
  llm_confidence: z.number().optional(),
}).passthrough();

const SemanticSearchResponseSchema = z.object({
  hits: z.array(z.object({
    event_id: z.string(),
    score: z.number(),
    highlights: z.record(z.string()),
    doc: SemanticSearchDocSchema,
  })),
  total: z.number(),
  query_time_ms: z.number(),
});

const LlmStatusSchema = z.object({
  enabled: z.boolean(),
  policy: z.string().optional(),
  models: z.record(z.string()).nullable(),
  queueDepth: z.number().nullable().optional(),
  semanticStore: z.object({
    provider: z.string().optional(),
    enabled: z.boolean(),
    healthy: z.boolean().optional(),
    collection: z.string().nullable().optional(),
    pointsCount: z.number().nullable().optional(),
    indexedVectorsCount: z.number().nullable().optional(),
  }).optional(),
});

const LlmImportCleanupResponseSchema = z.object({
  suggestions: z.array(z.object({
    id: z.string().optional(),
    url: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()),
    category: z.string().optional(),
    confidence: z.number(),
  })),
});

const LlmCollectionSuggestionsSchema = z.object({
  suggestions: z.array(z.object({
    name: z.string(),
    kind: z.enum(['tag', 'category']),
    score: z.number(),
  })),
});

const PublicBookmarkSchema = z.object({
  id: z.string(),
  pubkey: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  archivedForever: z.boolean(),
  blossomHash: z.string().optional(),
  waybackUrl: z.string().optional(),
  publishedAt: z.number().optional(),
  savedAt: z.number(),
  savedAtMs: z.number().optional(),
  eventCreatedAt: z.number().optional(),
});

const PublicBookmarkListResponseSchema = z.object({
  bookmarks: z.array(PublicBookmarkSchema),
  count: z.number(),
});

const ReportResponseSchema = z.object({ ok: z.literal(true) });

const SocialBookmarkPrefetchResponseSchema = z.object({
  requested: z.number(),
  found: z.number(),
  imported: z.number(),
  failed: z.number(),
});

const LifetimeStatusSchema = z.object({
  pubkey: z.string(),
  isLifetimeMember: z.boolean(),
  paidAt: z.number().nullable(),
});

const LifetimeInvoiceResponseSchema = z.object({
  invoiceId: z.string(),
  checkoutLink: z.string().url(),
  amountSats: z.number(),
  expiresAt: z.number(),
});

const MediaArchiveAddonStatusSchema = z.object({
  purchased: z.boolean(),
  paidAt: z.number().nullable(),
  amountSats: z.number(),
  lifetimeRequired: z.boolean().optional(),
});

const MediaArchiveAddonEnqueueResponseSchema = z.object({
  paymentHash: z.string(),
  jobId: z.string(),
  amountSats: z.literal(0),
  canonicalUrl: z.string(),
  videoId: z.string().optional(),
  videoContentKey: z.string().optional(),
});

// ── /api/v1/keys — lifetime-tier API key management ────────────────────────
// Plaintext is returned ONLY on creation; subsequent list calls return
// metadata only. See api/src/api-keys.ts for storage details.

const ApiKeyMetadataSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number(),
  // Backend always emits 0 for "never" — no default(): keeps the output type
  // `number` on both sides (z.infer uses input type when defaults exist).
  lastUsedAt: z.number()
});

const ApiKeyCreateResponseSchema = z.object({
  key: z.string(),
  id: z.string(),
  label: z.string(),
  createdAt: z.number()
});

const ApiKeyListResponseSchema = z.object({
  keys: z.array(ApiKeyMetadataSchema)
});

const ApiKeyRevokeResponseSchema = z.object({ ok: z.literal(true) });

// ── /account/archives — list shipped archives (NIP-98 auth) ────────────
const ArchiveFileSchema = z.object({
  role: z.enum(['html', 'pdf', 'file', 'media']),
  blobHash: z.string(),
  url: z.string(),
  source: z.enum(['wayback', 'rendered', 'file']).optional(),
  contentType: z.string().optional(),
  fileName: z.string().optional(),
  thumbHash: z.string().optional(),
  mirrors: z.array(z.object({
    url: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  })).optional(),
});

const ArchiveRecordSchema = z.object({
  jobId: z.string(),
  url: z.string(),
  originalUrl: z.string().optional(),
  blobHash: z.string(),
  tier: z.string(),
  source: z.string().optional(),
  archivedAt: z.number(),
  completedAt: z.number().optional(),
  bookmarkSavedAt: z.number().optional(),
  contentType: z.string().optional(),
  fileName: z.string().optional(),
  kind: z.string().optional(),
  videoId: z.string().optional(),
  videoContentKey: z.string().optional(),
  videoTitle: z.string().optional(),
  videoChannel: z.string().optional(),
  videoDurationSeconds: z.number().optional(),
  /** RFC 6381 MSE type for fragmented-MP4 media — enables streaming
   *  playback (see archives/download.ts openArchiveMediaStream). */
  mseCodecs: z.string().optional(),
  // Viewport-screenshot blob hash. UI fetches via
  // <img src=https://blossom.deepmarks.org/<thumbHash>>. Optional
  // because old archives can predate the screenshot pipeline and
  // private archives may be returned without a public thumbnail.
  thumbHash: z.string().optional(),
  files: z.array(ArchiveFileSchema).optional(),
  /** BUD-04 mirror fanout results recorded at archive time. `url` is the
   *  mirror server base; the blob lives at `<url>/<blobHash>`. Read by
   *  fetchArchiveBytes as fallback sources when the primary 404s. */
  mirrors: z.array(z.object({
    url: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  })).optional(),
});
const ArchiveFailureRecordSchema = z.object({
  jobId: z.string(),
  ownerPubkey: z.string(),
  url: z.string(),
  reason: z.enum(['site-blocked', 'not-found', 'too-large', 'timeout', 'failed']),
  message: z.string(),
  error: z.string().optional(),
  errorCategory: z.string().optional(),
  failedAt: z.number(),
  bookmarkSavedAt: z.number().optional(),
  tier: z.string().optional(),
  kind: z.string().optional(),
});
const ArchiveListResponseSchema = z.object({
  archives: z.array(ArchiveRecordSchema),
  count: z.number(),
  total: z.number(),
  failures: z.array(ArchiveFailureRecordSchema).optional(),
});

const ArchiveQueueStatusSchema = z.object({
  pending: z.number(),
  running: z.number(),
  archivedTotal: z.number(),
  mediaPending: z.number().optional(),
  mediaRunning: z.number().optional(),
});
export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;
export type ArchiveFailureRecord = z.infer<typeof ArchiveFailureRecordSchema>;
export type ArchiveListResponse = z.infer<typeof ArchiveListResponseSchema>;

// ── /account/username — short-handle claim/lookup ──────────────────────
const UsernameLookupSchema = z.object({ name: z.string(), pubkey: z.string() });
const UsernameReleaseSchema = z.object({ released: z.string().nullable() });
const UsernameAvailableSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({
    available: z.literal(false),
    reason: z.enum(['invalid', 'reserved', 'taken', 'cooldown']),
  }),
]);

const AccountDeleteResponseSchema = z.object({
  ok: z.literal(true),
  releasedUsername: z.string().nullable(),
  revokedApiKeys: z.number(),
  privateMarksRemoved: z.number(),
  passkeysRemoved: z.number().optional(),
  ciphertextRemoved: z.boolean().optional(),
  hadAccount: z.boolean(),
  archivesRemoved: z.number().optional(),
  archivePrimaryDeleted: z.number().optional(),
  archiveThumbsDeleted: z.number().optional(),
  archiveMirrorDeleteJobs: z.number().optional(),
  archiveDeleteErrors: z.array(z.string()).optional(),
  releasedUsernameCooldown: z.boolean().optional(),
  settingsRemoved: z.boolean().optional(),
});

const AccountRelaySchema = z.object({
  url: z.string(),
  read: z.boolean(),
  write: z.boolean(),
});

const ThemePreferenceSchema = z.enum(['light', 'dark', 'auto']);

const AccountSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.number(),
  relays: z.array(AccountRelaySchema),
  defaultTags: z.array(z.string()),
  defaultVisibility: z.enum(['private', 'public']),
  archiveAllByDefault: z.boolean(),
  archiveDefaultManualOverride: z.boolean(),
  backupBlossomServers: z.array(z.string()),
  theme: z.union([ThemePreferenceSchema, z.undefined()]).transform((theme) => theme ?? 'auto'),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

const AccountContactSchema = z.object({
  pubkey: z.string(),
  npub: z.string(),
  name: z.string().optional(),
  picture: z.string().optional(),
  nip05: z.string().optional(),
  deepmarksUsername: z.string().optional(),
  registered: z.boolean().optional(),
});

const AccountContactsResponseSchema = z.object({
  count: z.number(),
  contacts: z.array(AccountContactSchema),
  hasContactList: z.boolean(),
});

const AccountPeopleSearchResponseSchema = z.object({
  query: z.string(),
  count: z.number(),
  people: z.array(AccountContactSchema),
});

// ── Public types (derived from schemas — single source of truth) ────────────

export type UrlMetadata = z.infer<typeof UrlMetadataSchema>;
export type ArchiveStatus = z.infer<typeof ArchiveStatusSchema>;
export type ArchiveQueueStatus = z.infer<typeof ArchiveQueueStatusSchema>;
export type SearchPublicResponse = z.infer<typeof SearchPublicResponseSchema>;
export type SemanticSearchResponse = z.infer<typeof SemanticSearchResponseSchema>;
export type PublicBookmark = z.infer<typeof PublicBookmarkSchema>;
export type PublicBookmarkListResponse = z.infer<typeof PublicBookmarkListResponseSchema>;
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponseSchema>;
export type MediaArchiveAddonStatus = z.infer<typeof MediaArchiveAddonStatusSchema>;
export type AccountContact = z.infer<typeof AccountContactSchema>;
export type AccountContactsResponse = z.infer<typeof AccountContactsResponseSchema>;
export type AccountPeopleSearchResponse = z.infer<typeof AccountPeopleSearchResponseSchema>;
export type SocialBookmarkPrefetchResponse = z.infer<typeof SocialBookmarkPrefetchResponseSchema>;
export type LlmImportCleanupResponse = z.infer<typeof LlmImportCleanupResponseSchema>;
export type LlmCollectionSuggestions = z.infer<typeof LlmCollectionSuggestionsSchema>;

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiValidationError extends Error {
  constructor(message: string, public path: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

async function request<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  init?: RequestInit
): Promise<z.output<S>> {
  const controller = init?.signal ? null : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    : null;
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      ...init,
      signal: init?.signal ?? controller?.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      }
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new ApiError('Request timed out. Check your connection and try again.', 0);
    }
    throw e;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(formatApiErrorMessage(res.status, res.statusText, text), res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    throw new ApiError(`Malformed JSON: ${(e as Error).message}`, res.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiValidationError(
      `Backend returned an unexpected shape for ${path}: ${parsed.error.message}`,
      path
    );
  }
  return parsed.data;
}

function formatApiErrorMessage(status: number, statusText: string, body: string): string {
  const detail = parseApiErrorDetail(body);
  if (status === 401 || status === 403) return detail || 'Your session expired. Reconnect your signer and try again.';
  if (status === 429) return 'Deepmarks is receiving too many requests. Wait a moment and try again.';
  if (status >= 500) return 'Deepmarks had a server problem. Try again in a moment.';
  if (detail) return detail;
  return `${status} ${statusText}`.trim() || 'Deepmarks request failed.';
}

function parseApiErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  let raw = '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') raw = parsed;
    else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      raw = stringField(record.message) || stringField(record.error) || stringField(record.detail);
    }
  } catch {
    raw = trimmed;
  }
  const detail = raw.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!detail || /^(internal error|internal server error|server error|unknown error)$/i.test(detail)) return '';
  return detail;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ── NIP-98 auth helper (for /api/v1/keys management calls) ─────────────────
// The user proves nsec possession by signing a kind:27235 event scoped to
// the exact URL + method. Backend verifies the signature + freshness window.

/**
 * UTF-8 safe base64 — avoids the legacy `unescape(encodeURIComponent(...))`
 * trick which misbehaves on high-surrogate pairs. `btoa` only handles
 * Latin-1, so we route through TextEncoder first.
 */
function toBase64Utf8(s: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function buildNip98AuthHeader(
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const [{ getNdk }, { NDKEvent }] = await Promise.all([
    import('$lib/nostr/ndk.js'),
    import('@nostr-dev-kit/ndk'),
  ]);
  const ndk = getNdk();
  // Generic across call sites (lifetime upgrade, archive gating, api key
  // management, etc). Callers that can redirect the user to /login should
  // do so before invoking this — the thrown error is a fallback for
  // flows that can't reasonably navigate away.
  if (!ndk.signer) throw new Error('Signer required — connect your signer to continue.');
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
    ['nonce', crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`],
  ];
  // Per NIP-98: bind the auth event to the request body via sha256(body)
  // in a `payload` tag. The server enforces this on body-bearing routes
  // so a captured Authorization header can't be replayed against
  // attacker-chosen bytes within the freshness window.
  if (body !== undefined) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const arr = new Uint8Array(buf);
    let hex = '';
    for (const b of arr) hex += b.toString(16).padStart(2, '0');
    tags.push(['payload', hex]);
  }
  const event = new NDKEvent(ndk, {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
  try {
    await event.sign();
  } catch (e) {
    throw new Error(`Signer refused to sign NIP-98 auth event: ${(e as Error).message}`);
  }
  const raw = JSON.stringify(event.rawEvent());
  return `Nostr ${toBase64Utf8(raw)}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export const api = {
  publicBookmarks(authorPubkey: string, limit = 200): Promise<PublicBookmarkListResponse> {
    const qs = new URLSearchParams({ author: authorPubkey, limit: String(limit) });
    return request(`/bookmarks/public?${qs}`, PublicBookmarkListResponseSchema);
  },

  /** Fetch URL metadata for the save form's autofill. Pass
   *  `{ fast: true }` (used in the native mobile shells) to skip the
   *  server's inline LLM enrichment so the form populates as fast as
   *  possible — the bookmark still gets enriched by the backend backfill
   *  once saved. */
  metadata(url: string, opts: { fast?: boolean } = {}): Promise<UrlMetadata> {
    const qs = opts.fast ? '&enrich=0' : '';
    return request(`/metadata?url=${encodeURIComponent(url)}${qs}`, UrlMetadataSchema);
  },

  /** Tags other Deepmarks users have applied to public kind:39701
   *  bookmarks of this URL, ranked by frequency. Used by the save form
   *  autocomplete: "what have others tagged this with?". */
  popularTags(url: string): Promise<{ url: string; tags: string[] }> {
    return request(
      `/tags/popular?url=${encodeURIComponent(url)}`,
      PopularTagsResponseSchema,
    );
  },
  /**
   * Lifetime-member free archive bypass. Requires NIP-98 auth from a
   * pubkey stamped as a lifetime member (server checks LifetimeStore).
   * Returns a synthetic paymentHash/jobId for status polling.
   */
  async enqueueLifetimeArchive(body: {
    url: string;
    eventId?: string;
    tier?: 'private' | 'public';
    archiveKey?: string;
    mirrorUrls?: string[];
    bookmarkSavedAt?: number;
    dedupe?: boolean;
  }): Promise<{ paymentHash: string; jobId: string; amountSats: 0 }> {
    const path = '/archive/lifetime';
    const bodyStr = JSON.stringify(body);
    const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
    return request(path, LifetimeArchiveResponseSchema, {
      method: 'POST',
      headers: { Authorization: auth },
      body: bodyStr,
    });
  },
  archiveStatus(hashOrJobId: string): Promise<ArchiveStatus> {
    return request(
      `/archive/status/${encodeURIComponent(hashOrJobId)}`,
      ArchiveStatusSchema
    );
  },
  searchPublic(
    q: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<SearchPublicResponse> {
    const params = new URLSearchParams({ q });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return request(`/search/public?${params.toString()}`, SearchPublicResponseSchema);
  },
  searchSemanticPublic(
    q: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<SemanticSearchResponse> {
    const params = new URLSearchParams({ q });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return request(`/search/semantic/public?${params.toString()}`, SemanticSearchResponseSchema);
  },
  llm: {
    status(): Promise<z.infer<typeof LlmStatusSchema>> {
      return request('/llm/status', LlmStatusSchema);
    },
    async cleanupImport(items: Array<{
      id?: string;
      url: string;
      title?: string;
      description?: string;
      tags?: string[];
    }>): Promise<LlmImportCleanupResponse> {
      const path = '/llm/import/cleanup';
      const bodyStr = JSON.stringify({ items });
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, LlmImportCleanupResponseSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
    async suggestCollections(limit = 12): Promise<LlmCollectionSuggestions> {
      const path = `/llm/collections/suggest?limit=${encodeURIComponent(String(limit))}`;
      const auth = await buildNip98AuthHeader(`${config.apiBase}/llm/collections/suggest`, 'GET');
      return request(path, LlmCollectionSuggestionsSchema, {
        headers: { Authorization: auth },
      });
    },
  },
  report(eventId: string, reason: string): Promise<{ ok: true }> {
    return request('/report', ReportResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ eventId, reason })
    });
  },
  async prefetchSocialBookmarkTargets(body: {
    eventIds: string[];
    relays?: string[];
  }): Promise<SocialBookmarkPrefetchResponse> {
    const path = '/nostr/social-bookmarks/prefetch';
    const bodyStr = JSON.stringify(body);
    const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
    return request(path, SocialBookmarkPrefetchResponseSchema, {
      method: 'POST',
      headers: { Authorization: auth },
      body: bodyStr,
    });
  },
  lifetime: {
    /** Public status check — is this pubkey a lifetime member? */
    status(pubkey: string): Promise<{ pubkey: string; isLifetimeMember: boolean; paidAt: number | null }> {
      return request(
        `/account/lifetime/status?pubkey=${encodeURIComponent(pubkey)}`,
        LifetimeStatusSchema,
      );
    },
    /**
     * Create a BTCPay checkout for the lifetime tier. Returns a
     * `checkoutLink` the UI redirects the user to; BTCPay's settlement
     * webhook stamps the pubkey server-side on success.
     */
    async checkout(redirectUrl?: string): Promise<{ invoiceId: string; checkoutLink: string; amountSats: number; expiresAt: number }> {
      const path = '/account/lifetime';
      const bodyStr = JSON.stringify({ redirectUrl });
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, LifetimeInvoiceResponseSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
  },
  mediaArchive: {
    async status(): Promise<MediaArchiveAddonStatus> {
      const path = '/add-on/video-archive/status';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(path, MediaArchiveAddonStatusSchema, {
        headers: { Authorization: auth },
      });
    },
    async checkout(redirectUrl?: string): Promise<{ invoiceId: string; checkoutLink: string; amountSats: number; expiresAt: number }> {
      const path = '/add-on/video-archive/checkout';
      const bodyStr = JSON.stringify({ redirectUrl });
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, LifetimeInvoiceResponseSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
    async enqueue(body: {
      url: string;
      archiveKey: string;
      eventId?: string;
      bookmarkSavedAt?: number;
    }): Promise<z.infer<typeof MediaArchiveAddonEnqueueResponseSchema>> {
      const path = '/add-on/video-archive/enqueue';
      const bodyStr = JSON.stringify(body);
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, MediaArchiveAddonEnqueueResponseSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
  },
  account: {
    /**
     * Tombstone every piece of server-side state tied to this pubkey:
     * deepmarks handle, API keys, private-mark ciphertexts, account
     * record. Lifetime-payment record is preserved.
     *
     * Caller is responsible for publishing NIP-09 kind:5 deletions for
     * the user's own Nostr events — the signer the user holds is what
     * authorizes those, not this backend.
     */
    async delete(): Promise<z.infer<typeof AccountDeleteResponseSchema>> {
      const path = '/account';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'DELETE');
      return request(path, AccountDeleteResponseSchema, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
    },
    async getSettings(): Promise<AccountSettings> {
      const path = '/account/settings';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(path, AccountSettingsSchema, {
        headers: { Authorization: auth },
      });
    },
    async putSettings(body: Omit<AccountSettings, 'schemaVersion' | 'updatedAt'>): Promise<AccountSettings> {
      const path = '/account/settings';
      const bodyStr = JSON.stringify(body);
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'PUT', bodyStr);
      return request(path, AccountSettingsSchema, {
        method: 'PUT',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
    async contacts(): Promise<AccountContactsResponse> {
      const path = '/account/contacts';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(path, AccountContactsResponseSchema, {
        headers: { Authorization: auth },
      });
    },
    async peopleSearch(q: string, limit = 30): Promise<AccountPeopleSearchResponse> {
      const path = `/account/people-search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`;
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(path, AccountPeopleSearchResponseSchema, {
        headers: { Authorization: auth },
      });
    },
  },
  username: {
    /** Resolve `alice` → pubkey, or throw 404. */
    lookup(name: string): Promise<{ name: string; pubkey: string }> {
      return request(
        `/account/username-lookup?name=${encodeURIComponent(name)}`,
        UsernameLookupSchema,
      );
    },
    /** Reverse — what handle does this pubkey hold? 404 if none. */
    ofPubkey(pubkey: string): Promise<{ name: string; pubkey: string }> {
      return request(
        `/account/username-of?pubkey=${encodeURIComponent(pubkey)}`,
        UsernameLookupSchema,
      );
    },
    /** Cheap availability + reason for the claim UI. */
    available(name: string) {
      return request(
        `/account/username-available?name=${encodeURIComponent(name)}`,
        UsernameAvailableSchema,
      );
    },
    /** Claim a handle — lifetime-gated on the server. */
    async claim(name: string): Promise<{ name: string; pubkey: string }> {
      const path = '/account/username';
      const bodyStr = JSON.stringify({ name });
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, UsernameLookupSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
    /** Release your handle into the 30-day cooldown. */
    async release(): Promise<{ released: string | null }> {
      const path = '/account/username';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'DELETE');
      return request(path, UsernameReleaseSchema, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
    },
  },
  keys: {
    /**
     * Create a new API key. Plaintext is returned exactly once — caller MUST
     * show the "save it now" UX; there is no later recovery path.
     */
    async create(label?: string): Promise<ApiKeyCreateResponse> {
      const path = '/api/v1/keys';
      const bodyStr = JSON.stringify({ label: label ?? 'unnamed' });
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
      return request(path, ApiKeyCreateResponseSchema, {
        method: 'POST',
        headers: { Authorization: auth },
        body: bodyStr,
      });
    },
    async list(): Promise<ApiKeyMetadata[]> {
      const path = '/api/v1/keys';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      const res = await request(path, ApiKeyListResponseSchema, {
        headers: { Authorization: auth }
      });
      return res.keys;
    },
    async revoke(id: string): Promise<void> {
      const path = `/api/v1/keys/${encodeURIComponent(id)}`;
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'DELETE');
      await request(path, ApiKeyRevokeResponseSchema, {
        method: 'DELETE',
        headers: { Authorization: auth }
      });
    }
  },
  archives: {
    /**
     * List the signed-in user's shipped archives via NIP-98 auth.
     * Same data as /api/v1/archives but Bearer-key-free. Lifetime
     * users with API keys can also use the Bearer route in scripts;
     * this is the in-app path.
     */
    async list(opts: { limit?: number; offset?: number } = {}): Promise<ArchiveRecord[]> {
      const res = await this.page(opts);
      return res.archives;
    },
    async page(opts: { limit?: number; offset?: number } = {}, authHeader?: string): Promise<ArchiveListResponse> {
      const path = '/account/archives';
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.offset !== undefined) params.set('offset', String(opts.offset));
      const requestPath = params.toString() ? `${path}?${params.toString()}` : path;
      // Server's NIP-98 verifier intentionally scopes this route to the
      // path without pagination query params, so all pages share the same
      // signed URL and only vary by harmless limit/offset.
      const auth = authHeader ?? await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(requestPath, ArchiveListResponseSchema, {
        headers: { Authorization: auth },
      });
    },
    async listAll(): Promise<ArchiveRecord[]> {
      const all: ArchiveRecord[] = [];
      // Big page size keeps most users to one round-trip. NIP-98
      // replay protection makes auth headers single-use, so each
      // additional page costs one fresh sign + relay round-trip on a
      // bunker signer. Server caps internally; we still send the
      // generous limit so users with smaller libraries fit in one call.
      const limit = 5000;
      for (let offset = 0; offset <= 50_000; offset += limit) {
        const page = await this.page({ limit, offset });
        all.push(...page.archives);
        if (page.count === 0 || all.length >= page.total) break;
      }
      return all;
    },
    async queueStatus(): Promise<ArchiveQueueStatus> {
      const path = '/account/archive-queue';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      return request(path, ArchiveQueueStatusSchema, {
        headers: { Authorization: auth },
      });
    },
  },
};
