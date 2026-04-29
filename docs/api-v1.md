# Deepmarks API v1

Programmatic access to your bookmarks and archives. **Lifetime-tier members only** (21,000-sat one-time payment). Per-archive buyers are not eligible — the sovereignty story is that anyone can use the app, talk to relays directly, write a native Nostr client, and get all their data out for free. The API is a *convenience* that Deepmarks operates for lifetime members.

## Authentication

Two schemes, depending on the endpoint:

| Endpoints | Scheme | Notes |
| --- | --- | --- |
| `POST /api/v1/keys`, `GET /api/v1/keys`, `DELETE /api/v1/keys/:id` | **NIP-98** | Proves nsec possession. Server refuses to accept an API key when creating another API key — prevents a leaked key from self-propagating. |
| Everything else | **Bearer** `dmk_live_…` | Hand out to scripts and bots. Rotate any time from `/app/settings`. |

### NIP-98 auth header

Sign a `kind:27235` event with `u` and `method` tags:

```json
{
  "kind": 27235,
  "created_at": 1700000000,
  "tags": [
    ["u", "https://deepmarks.org/api/v1/keys"],
    ["method", "POST"]
  ],
  "content": "",
  "pubkey": "...",
  "id": "...",
  "sig": "..."
}
```

Base64-encode the full JSON string and pass as `Authorization: Nostr <base64>`. The server rejects events that are stale (>60 s clock skew) or whose `u` / `method` tags don't exactly match the request.

### Bearer auth

```
Authorization: Bearer dmk_live_<43 url-safe base64 chars>
```

Format: `dmk_live_` prefix + 32 random bytes encoded as url-safe base64 (43 chars). Greppable by secret scanners. Only the SHA-256 hash is persisted server-side.

## Endpoints

All paths are relative to `https://deepmarks.org` in production, `http://localhost:4000` in local dev.

### POST /api/v1/keys

Create a new API key. **Lifetime-tier gated.**

```bash
curl -X POST https://deepmarks.org/api/v1/keys \
  -H "Authorization: Nostr $(build-nip98-header POST /api/v1/keys)" \
  -H "Content-Type: application/json" \
  -d '{"label":"my-import-script"}'
```

**201 Created**:
```json
{
  "key": "dmk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "id": "<sha256-hex>",
  "label": "my-import-script",
  "createdAt": 1700000000
}
```

The plaintext `key` is returned **exactly once**. Store it immediately — there is no recovery path.

**402 Payment Required** when the caller isn't a lifetime member:
```json
{ "error": "api access is available to lifetime-tier members (21,000 sats)", "upgradeUrl": "https://deepmarks.org/pricing" }
```

### GET /api/v1/keys

List metadata for every key owned by the authenticated pubkey. Plaintext is never returned here.

```bash
curl https://deepmarks.org/api/v1/keys \
  -H "Authorization: Nostr $(build-nip98-header GET /api/v1/keys)"
```

**200 OK**:
```json
{
  "keys": [
    { "id": "...", "label": "my-import-script", "createdAt": 1700000000, "lastUsedAt": 1700050000 }
  ]
}
```

### DELETE /api/v1/keys/:id

Revoke a key. Revocation is immediate at the server; any in-flight requests using the key will 401.

```bash
curl -X DELETE https://deepmarks.org/api/v1/keys/$KEY_ID \
  -H "Authorization: Nostr $(build-nip98-header DELETE /api/v1/keys/$KEY_ID)"
```

**200 OK**: `{ "ok": true }` — or 404 if the id is unknown or not yours.

### GET /api/v1/bookmarks

List or search the caller's own `kind:39701` PUBLIC bookmarks. Private NIP-51 bookmarks (`kind:30003`) are encrypted client-side and intentionally NOT exposed through this endpoint or anywhere under `/api/v1/*` — see [Privacy](#privacy--whats-never-exposed).

Two modes, automatically picked from the query shape:

- **Simple list** — empty `q`, ≤1 tag, `offset=0`. Goes straight to the relay subscription so the very latest writes show up before Meilisearch's indexer catches up. Supports the `archived` filter.
- **Search** — `q`, multiple tags, OR `offset > 0`. Routes through Meilisearch with a hard `author_pubkey = me` filter. The `archived` filter is NOT honored in this mode (Meili's index doesn't store archive-tier).

Query parameters:
- `q` — full-text search across `title` + `description` (forces search mode)
- `tag` — filter by `t` tag value; **repeatable** (`?tag=rust&tag=async`) for AND
- `limit` — max records, 1–500, default 200
- `offset` — pagination, 0–10 000 (forces search mode)
- `archived=true` — only entries with an `archive-tier` tag (simple-list mode only)

```bash
# Simple list — newest 50 with the bitcoin tag
curl "https://deepmarks.org/api/v1/bookmarks?tag=bitcoin&limit=50" \
  -H "Authorization: Bearer $DMK_KEY"

# Full-text search — "rust async" with two AND'd tags
curl "https://deepmarks.org/api/v1/bookmarks?q=rust+async&tag=tokio&tag=hyper&limit=20" \
  -H "Authorization: Bearer $DMK_KEY"
```

**200 OK** (simple-list mode):
```json
{
  "bookmarks": [
    {
      "id": "<event-id>", "pubkey": "<curator>",
      "url": "https://example.com/article",
      "title": "An Article", "description": "A short summary",
      "tags": ["bitcoin", "lightning"],
      "archivedForever": true,
      "blossomHash": "sha256-...", "waybackUrl": "https://web.archive.org/...",
      "publishedAt": 1699000000, "savedAt": 1700000000
    }
  ],
  "count": 1, "mode": "list"
}
```

**200 OK** (search mode — Meili shape, no archive metadata):
```json
{
  "bookmarks": [
    {
      "id": "<event-id>", "pubkey": "<curator>",
      "url": "https://example.com/article",
      "title": "An Article", "description": "A short summary",
      "tags": ["rust", "async"],
      "savedAt": 1700000000, "saveCount": 3, "zapTotal": 1500
    }
  ],
  "count": 1, "total": 47, "mode": "search"
}
```

### GET /api/v1/search/public

Search **everyone's** public bookmarks. Same query language as the search box on the public site. Always returns `kind:39701` only — private content has no representation in the index.

Query parameters:
- `q` — search text
- `tag` — repeatable, AND-combined
- `author` — hex pubkey filter (single curator)
- `site` — domain filter (e.g. `github.com`)
- `limit` — 1–100, default 50
- `offset` — 0–10 000

```bash
curl "https://deepmarks.org/api/v1/search/public?q=bitcoin&tag=lightning&site=stacker.news" \
  -H "Authorization: Bearer $DMK_KEY"
```

**200 OK**:
```json
{
  "hits": [
    {
      "bookmark": { "id": "...", "pubkey": "...", "url": "...", "title": "...",
                    "description": "...", "tags": ["..."], "savedAt": 1700000000,
                    "saveCount": 12, "zapTotal": 4200 },
      "score": 0.87
    }
  ],
  "total": 47,
  "query_time_ms": 12
}
```

### POST /api/v1/bookmarks

Publish a pre-signed `kind:39701` event to the relay network.

**Why pre-signed?** The server never holds your nsec. You sign locally; the API fans out to relays. This is a thin publish proxy — the convenience is retry logic, multi-relay fanout, and indexing, not key delegation.

```bash
curl -X POST https://deepmarks.org/api/v1/bookmarks \
  -H "Authorization: Bearer $DMK_KEY" \
  -H "Content-Type: application/json" \
  -d '<signed-kind-39701-event-json>'
```

Request body must be a complete signed event: `{ id, pubkey, created_at, kind, tags, content, sig }`.

**Hard requirements:**
- `kind === 39701`
- `pubkey` matches the API key owner (prevents someone with a leaked key publishing for a different account — the signature couldn't be produced without the victim's nsec anyway, but we double-check)
- signature verifies
- has a `d` tag with the URL (NIP-B0 requirement)
- `d` tag URL must be `http(s)` only — no `javascript:`/`data:`/`file:`
- `created_at` must not be more than 10 minutes in the future (past timestamps fine — historic imports allowed)

**200 OK**:
```json
{ "eventId": "...", "publishedTo": ["wss://relay.deepmarks.org"], "failedRelays": [] }
```

### DELETE /api/v1/bookmarks/:eventId

Publish a pre-signed `kind:5` deletion event targeting `:eventId`.

```bash
curl -X DELETE https://deepmarks.org/api/v1/bookmarks/$EVENT_ID \
  -H "Authorization: Bearer $DMK_KEY" \
  -H "Content-Type: application/json" \
  -d '<signed-kind-5-event-json>'
```

The body's event must (a) be `kind:5`, (b) be signed by the API key owner, (c) include an `e`-tag matching `:eventId`. The `:eventId` route param must be 64-char lowercase hex; non-hex values are rejected at the door so garbage can't reach relays.

### POST /api/v1/archives

Start a paid archive purchase (500 sats). Returns a BOLT-11 invoice you pay via any Lightning wallet; poll `GET /api/v1/archives/:jobId` until the job completes.

```bash
curl -X POST https://deepmarks.org/api/v1/archives \
  -H "Authorization: Bearer $DMK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/article"}'
```

**200 OK**:
```json
{
  "jobId": "<payment-hash>",
  "invoice": "lnbc1...",
  "amountSats": 500,
  "expiresInSeconds": 3600
}
```

Server returns **503** when Lightning isn't configured (dev mode without Voltage creds).

### GET /api/v1/archives/:jobId

Poll status for a purchased archive.

```bash
curl https://deepmarks.org/api/v1/archives/$JOB_ID \
  -H "Authorization: Bearer $DMK_KEY"
```

States: `pending` · `paid` · `enqueued` · `expired`. (Successful completion shows up in `GET /api/v1/archives` below — the invoice-status endpoint above tracks the *invoice* lifecycle, not the *archive* lifecycle.)

### GET /api/v1/archives

List your shipped (successfully completed) archives. Paginated, newest first. For in-flight jobs, poll `GET /api/v1/archives/:jobId` instead.

Query parameters:
- `limit` — 1–500, default 100
- `offset` — 0–10 000

```bash
curl "https://deepmarks.org/api/v1/archives?limit=50" \
  -H "Authorization: Bearer $DMK_KEY"
```

**200 OK**:
```json
{
  "archives": [
    {
      "jobId": "<payment-hash>",
      "url": "https://example.com/article",
      "blobHash": "sha256-hex",
      "tier": "public",
      "source": "rendered",
      "archivedAt": 1700000000
    }
  ],
  "count": 1, "total": 73
}
```

The `blobHash` is a SHA-256 you can fetch from any Blossom server hosting the archive (current default: `https://blossom.deepmarks.org/<blobHash>`).

### NIP-98 sibling: `GET /account/archives` and `DELETE /account/archives/:blobHash`

Same data shape as `GET /api/v1/archives`, but authed via NIP-98 (kind:27235 HTTP-Auth) instead of Bearer keys. Use this from any nsec holder — including non-lifetime users who paid for individual archives — when a Bearer key isn't issued. The web app's `/app/archives` page and the browser extension's archived tab both use this endpoint.

`DELETE /account/archives/:blobHash` removes the archive from your account in three coordinated steps:
1. drops the entry from `dm:archives:<authPubkey>` so the GET sibling stops returning it
2. issues an S3 `deleteObject` against the Blossom bucket so `blossom.deepmarks.org/<hash>` starts returning 404
3. (client-side, separately) for private archives the browser extension purges the AES key from `chrome.storage.local` and re-publishes the user's NIP-51 `deepmarks-archive-keys` set without the entry — so even mirror copies of the ciphertext become mathematically unreadable

**Response shape**:
```json
{
  "ok": true,
  "blobHash": "...",
  "url": "...",
  "tier": "private",
  "primaryDeleted": true,
  "mirrorsRetained": true,
  "mirrorNote": "Mirrors still host the ciphertext. Wipe the archive key from your NIP-51 set and local cache to make those copies unreadable."
}
```

`mirrorsRetained` is always `true` today — we have no protocol mechanism to instruct mirror operators (Primal, Satellite CDN, hzrd149) to drop blobs. Public archives are effectively permanent once mirrored; private archives become unreadable after key purge. See `/pricing#archive-deletion` for the full FAQ.

## Error model

All errors return JSON with an `error` string. Common codes:

| Status | Meaning |
| --- | --- |
| 400 | Validation failed (bad event shape, missing tag, etc.) |
| 401 | Missing / invalid Bearer token or NIP-98 header |
| 402 | Not a lifetime-tier member (key creation only) |
| 403 | Event `pubkey` doesn't match API key owner |
| 404 | Key / job not found |
| 503 | Lightning not configured (archive endpoints only) |

## Example: save a bookmark from a Python script

```python
import json, time, requests
from nostr_tools import sign_event  # hypothetical

API = "https://deepmarks.org"
KEY = "dmk_live_..."

event = sign_event({
  "kind": 39701,
  "created_at": int(time.time()),
  "content": "",
  "tags": [
    ["d", "https://example.com/article"],
    ["title", "An Article"],
    ["t", "reading"],
  ],
})

r = requests.post(
    f"{API}/api/v1/bookmarks",
    headers={"Authorization": f"Bearer {KEY}"},
    json=event,
)
r.raise_for_status()
print(r.json())
```

## Revoking a leaked key

1. `/app/settings` → **api access** → click **revoke** next to the key label.
2. Or `DELETE /api/v1/keys/:id` with NIP-98 auth.

Revocation is immediate. Rotate by revoking the old key and creating a new one — there is no in-place "rotate" operation because the new plaintext is returned once and can't be re-fetched.

## Privacy — what's never exposed

- **Private bookmarks.** Stored as NIP-51 (`kind:30003`) sets encrypted to your own pubkey via NIP-44 v2. The server holds ciphertext only and the API has no decrypt path. They never appear in any `/api/v1/*` response.
- **Other users' private bookmarks.** Same — `/api/v1/search/public` only indexes `kind:39701`, never `kind:30003`.
- **Your nsec.** Never sent to the API. Signing happens in your script.
- **Email addresses.** Only stored as a salted hash for account recovery. Not exposed under `/api/v1`.

## Rate limits

Per-pubkey unless noted. 429 responses include a `Retry-After` header in seconds.

| Endpoint | Limit |
| --- | --- |
| `POST /api/v1/keys` | 5 / hour |
| `GET /api/v1/bookmarks` (search mode) | 60 / minute |
| `GET /api/v1/search/public` | 60 / minute |
| `POST /api/v1/archives` | 10 / minute (per pubkey) + 30 / minute (per API key) |

Public-side ungated rate limits that apply to the underlying routes the API shares (relevant if you script around them):

| Endpoint | Limit |
| --- | --- |
| `/search/public` (web equivalent of `/api/v1/search/public`) | 120 / minute (per IP) |
| `/account/lifetime/status` | 60 / minute (per IP) |
| `/account/username-{lookup,of}` | 120 / minute (per IP) |
| `/account/username-available` | 240 / minute (per IP) |

## Security notes

- **Plaintext is stored nowhere.** Only SHA-256 hashes of API keys live in Redis.
- **Keys are greppable.** The `dmk_live_` prefix is deliberate — secret scanners in GitHub, Gitleaks, etc. can detect them in logs and commits.
- **Server never signs events for you.** Every write carries a pre-signed event; the server verifies and relays it.
- **No admin macaroon.** The service only uses `invoice.macaroon` — it can neither spend sats nor inspect private channels.

## See also

- [Root README](../README.md)
- [payment-proxy README](../payment-proxy/README.md)
- NIP-98 (HTTP Auth): https://github.com/nostr-protocol/nips/blob/master/98.md
- NIP-B0 (Web Bookmarks): https://github.com/nostr-protocol/nips/blob/master/B0.md
- NIP-51 (Lists, used for private bookmark sets): https://github.com/nostr-protocol/nips/blob/master/51.md
