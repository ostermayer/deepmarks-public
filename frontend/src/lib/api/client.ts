// Thin wrapper around payment-proxy + metadata HTTP endpoints.
// Frontend never holds long-lived credentials; auth is per-call via the
// caller's signer (or a short-lived JWT for email-linked sessions).
//
// Per CLAUDE.md: validate at boundaries. Every response is parsed through
// a zod schema so a misbehaving backend can't poison the UI with garbage.

import { z } from 'zod';
import { config } from '$lib/config.js';
import { getNdk } from '$lib/nostr/ndk.js';
import { NDKEvent } from '@nostr-dev-kit/ndk';

// ── Response schemas ────────────────────────────────────────────────────────

const UrlMetadataSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  favicon: z.string().optional(),
  lightning: z.string().optional(),
  // Backend always emits an array (possibly empty). Kept as optional on the
  // type so z.infer stays consistent with the "no defaults" convention
  // above — callers should coalesce with `?? []` when reading.
  suggestedTags: z.array(z.string()).optional()
});

const ArchivePurchaseResponseSchema = z.object({
  invoice: z.string(),
  paymentHash: z.string(),
  jobId: z.string(),
  amountSats: z.number()
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
  mirrors: z.array(z.object({ server: z.string(), ok: z.boolean() })).optional(),
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

const ReportResponseSchema = z.object({ ok: z.literal(true) });

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

// ── /api/v1/keys — lifetime-tier API key management ────────────────────────
// Plaintext is returned ONLY on creation; subsequent list calls return
// metadata only. See payment-proxy/src/api-keys.ts for storage details.

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
const ArchiveRecordSchema = z.object({
  jobId: z.string(),
  url: z.string(),
  blobHash: z.string(),
  tier: z.string(),
  source: z.string().optional(),
  archivedAt: z.number(),
  // Viewport-screenshot blob hash, public-tier only. UI fetches via
  // <img src=https://blossom.deepmarks.org/<thumbHash>>. Optional
  // because: (a) old archives predate the screenshot pipeline, and
  // (b) private archives intentionally skip thumbnail upload.
  thumbHash: z.string().optional(),
});
const ArchiveListResponseSchema = z.object({
  archives: z.array(ArchiveRecordSchema),
  count: z.number(),
  total: z.number(),
});
export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;

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
  hadAccount: z.boolean(),
});

// ── Public types (derived from schemas — single source of truth) ────────────

export type UrlMetadata = z.infer<typeof UrlMetadataSchema>;
export type ArchivePurchaseResponse = z.infer<typeof ArchivePurchaseResponseSchema>;
export type ArchiveStatus = z.infer<typeof ArchiveStatusSchema>;
export type SearchPublicResponse = z.infer<typeof SearchPublicResponseSchema>;
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponseSchema>;

export interface ArchivePurchaseRequest {
  url: string;
  tier: 'private' | 'public';
  /** Required for private tier — payment-proxy uses this to address the encrypted blob to the user. */
  pubkey: string;
}

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

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      `${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
      res.status
    );
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
  const ndk = getNdk();
  // Generic across call sites (lifetime upgrade, archive gating, api key
  // management, etc). Callers that can redirect the user to /login should
  // do so before invoking this — the thrown error is a fallback for
  // flows that can't reasonably navigate away.
  if (!ndk.signer) throw new Error('Signer required — connect your signer to continue.');
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
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
  metadata(url: string): Promise<UrlMetadata> {
    return request(`/metadata?url=${encodeURIComponent(url)}`, UrlMetadataSchema);
  },
  async purchaseArchive(body: ArchivePurchaseRequest): Promise<ArchivePurchaseResponse> {
    // NIP-98-gated server-side so the per-pubkey rate limit can't be
    // dodged by rotating body.userPubkey. The signed pubkey overrides
    // whatever the body claims.
    const path = '/archive/purchase';
    const bodyStr = JSON.stringify(body);
    const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'POST', bodyStr);
    return request(path, ArchivePurchaseResponseSchema, {
      method: 'POST',
      headers: { Authorization: auth },
      body: bodyStr,
    });
  },
  /**
   * Lifetime-member free archive bypass. Requires NIP-98 auth from a
   * pubkey stamped as a lifetime member (server checks LifetimeStore).
   * Returns the same shape as purchaseArchive minus the invoice so
   * callers can branch on `amountSats === 0`.
   */
  async purchaseArchiveLifetime(body: { url: string; eventId?: string }): Promise<{ paymentHash: string; jobId: string; amountSats: 0 }> {
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
  report(eventId: string, reason: string): Promise<{ ok: true }> {
    return request('/report', ReportResponseSchema, {
      method: 'POST',
      body: JSON.stringify({ eventId, reason })
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
     * Same data as /api/v1/archives but Bearer-key-free — works for
     * anyone with an nsec, including non-lifetime users who paid for
     * individual archives. Lifetime users with API keys can also use
     * the Bearer route in their own scripts; this is the in-app path.
     */
    async list(): Promise<ArchiveRecord[]> {
      const path = '/account/archives';
      const auth = await buildNip98AuthHeader(`${config.apiBase}${path}`, 'GET');
      const res = await request(path, ArchiveListResponseSchema, {
        headers: { Authorization: auth },
      });
      return res.archives;
    },
  },
};
