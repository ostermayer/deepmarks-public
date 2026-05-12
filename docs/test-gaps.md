# Test gap analysis

Snapshot of unit-test coverage across the four codebases. Goal: identify
high-risk paths that lack automated coverage so additions can be prioritized.

## Headline numbers

| Codebase | Source files | Test files | Coverage posture |
|---|---:|---:|---|
| `payment-proxy/src/` | 87 | 23 | broad helper coverage; route-module wiring still thin |
| `archive-worker/src/` | 13 | 4 | crypto/Blossom/Wayback/mirrors covered; queue/worker thin |
| `bunker/src/` | 13 | 5 | core signing pipeline covered; relay/config thin |
| `browser-extension/src/` | 41 | 4 | first tests landed; background/content-script paths thin |
| `frontend/src/lib/` | many | many | high relative coverage; UI regressions still need browser checks |

Current verification count: 305 payment-proxy tests, 299 frontend tests,
50 bunker tests, 35 archive-worker tests, and 18 browser-extension tests,
for **707 tests** total.

The browser-extension surface now has a small Vitest foothold
(`nsec-store`, `nostr`, `nwc-store`, and popup drafts), but the highest
risk areas are still under-covered:

- `lib/archive-keys.ts` + `lib/archive-keys-sync.ts` — Phase-2B NIP-51
  archive-key wrap/unwrap, stash-and-reconcile flow. Losing data here
  means private archives become unreadable. A round-trip test against
  a fake chrome.storage + relay would cost ~150 lines.
- `lib/nwc.ts` + `lib/nwc-store.ts` — NIP-47 client + URI parser. The
  preimage verification path (`sha256(preimage) === payment_hash`) is
  the only thing standing between us and a malicious wallet faking a
  payment confirmation.
- `lib/nostr.ts` — relay fallback/default handling has coverage now, but
  `deleteBookmark` (kind:5 with `e`+`a` tags) needs a round-trip test so
  the tag shape can't drift unnoticed.
- `content-scripts/nip07-bridge.ts` — the new method allowlist. A test
  that posts an unknown `method` and asserts a clean rejection is ~30
  lines and protects the UI-spoof boundary.
- `popup/screens/Add.tsx` edit-mode visibility flip — the
  delete-old-then-publish-new flow has zero coverage and is the most
  recently-shipped privacy-relevant code.

## Critical paths with NO direct tests

These rank highest because a regression here has user-visible blast radius.

### A. payment-proxy core that touches money

| File | Risk | Why no test is bad |
|---|---|---|
| `archive-purchase.ts` | HIGH | Lifetime archive enqueue plus legacy metered invoice settlement helper. Refactor regressions land here invisibly. |
| `invoice-handler.ts` | HIGH | LND `invoice_updated` callback dispatch — splits zap vs legacy metered archive handling. Includes the new `rollbackToPending` path (batch 13). A bug here means old in-flight invoices don't enqueue OR underpaid invoices credit. |
| `queue.ts` | HIGH | `markPaid` (atomic SET-NX gate), `enqueueArchiveJob`, `rollbackToPending`. The very mechanisms the financial paths rely on. |
| `passkey.ts` | HIGH | WebAuthn registration + assertion + the discoverable-credential path. `MAX_PASSKEYS_PER_PUBKEY` cap added in batch 15 — no test confirms the cap fires. |
| `ciphertext.ts` | MEDIUM | S3-backed nsec ciphertext storage. Size cap, ACL posture, key format. |
| `safe-url.ts` | HIGH | SSRF guard for `/archive/*` URL submission. Touched by every archive request. |

### B. payment-proxy route layer (thin direct tests)

Most route modules are still untested in isolation. Several helper
modules and feed routes have tests, but auth/body/rate-limit wiring for
the main account/archive/lifetime/admin routes remains thin. That means:

- Auth-gate wiring (NIP-98 vs Bearer vs requireSession) is only tested in production
- Body-binding (`bindBody: true`) per-route is only tested in production
- Rate-limit *bucket names* aren't tested — a typo silently means "no rate limit"
- The 11 different rate-limit gates added across batches 8/10/15 are each one path-trace away from being unverified

Route-level tests would catch:
- The batch-10 → batch-12 regression (server required NIP-98 on `/account/passkey/register`, frontend didn't send it)
- A future "added gate, forgot to wire it" mistake on a new endpoint

Suggested approach: add `routes/<name>.test.ts` files using Fastify's `inject` API — no real network needed. Start with the highest-stakes routes:

1. `routes/api-v1.ts` (470 lines, 9 endpoints, all financial or data-exposing)
2. `routes/archive.ts` (purchase, lifetime, callback, status)
3. `routes/lifetime.ts` (BTCPay invoice creation, webhook handler)
4. `routes/passkey.ts` (the recently-NIP-98-gated register endpoint)
5. `routes/admin.ts` (action dispatch, stamp, reconcile bounds)

### C. archive-worker

| File | Risk | Why no test is bad |
|---|---|---|
| `queue.ts` | HIGH | `MAX_ATTEMPTS=5` cap added in batch 13 — no test fires it. `complete` pipeline error surfacing — no test verifies. JSON-parse skip on corrupt entries — no test. |
| `renderer.ts` | MEDIUM | Playwright-driven; hard to test cleanly. The subresource SSRF block (batch 9) and the 50 MB output cap (batch 9) are both unverified. |
| `worker.ts` | MEDIUM | Main loop. No test means a bad refactor crashes silently. |
| `safe-url.ts` | HIGH | DNS-resolve recheck path. Mirror of `payment-proxy/src/safe-url.ts` which IS tested — would be cheap to mirror the test suite. |

### D. bunker

Already has decent coverage (vault, handler, nip46, permissions, audit). Missing:

| File | Risk |
|---|---|
| `relay.ts` | MEDIUM — relay-pool reconnect logic |
| `config.ts` | LOW — env loading |

### E. browser extension (thin tests)

This is still the largest under-audited surface for regressions:

- `lib/nsec-store.ts` (encryption + cache modes + reveal flow) — partially tested, but needs more wrong-password/cache-mode coverage
- `lib/nsec-crypto.ts` (PBKDF2 + AES-GCM helpers) — **no tests**
- `lib/private-bookmarks.ts` (NIP-51 + NIP-44 v2 self-encrypt) — **no tests**
- `background/index.ts` (NIP-07 dispatch, pendingRequests cap, always-prompt-kinds) — **no tests**
- `lib/settings-store.ts` (single-flight write chain) — **no tests**

Suggested first additions:

1. **`nsec-crypto.test.ts`** — round-trip encrypt/decrypt, wrong-password rejection, salt/IV uniqueness across calls. Pure functions, easy to test.
2. **Expand `nsec-store.test.ts`** — set plain, set password, lock/unlock
   cycle, reveal-without-cache, change password, remove password. The
   stub `chrome.storage.{local,session}` scaffolding already exists.
3. **`background/nip07.test.ts`** — always-prompt-kinds enforcement, pendingRequests TTL/cap, event-template validation. Pure-function test of `isAlwaysPromptTemplate`, `validateEventTemplate`, `admitPending` after extracting them to a testable module.

## Lower-priority gaps (informational only)

- `payment-proxy/src/route-deps.ts` — pure type wiring, no behavior to test
- `payment-proxy/src/types.ts` — pure types
- `payment-proxy/src/index.ts` — bootstrap; integration test would be more useful than unit
- `payment-proxy/src/bootstrap.ts` — same
- `payment-proxy/src/workers-bootstrap.ts` — same
- `payment-proxy/src/email.ts` — thin Resend wrapper; production warning logic added in batch 15 isn't tested but the function is 4 lines

## What test additions would catch the recent regressions

| Recent incident | Would have been caught by |
|---|---|
| `*nsec*` gitignore dropping `nsec-store.ts` from commits (batch 8) | An extension build test in CI that imports `nsec-store` — would fail when the file isn't there |
| Batch-10 → batch-12 NIP-98 regression on `/account/passkey/register` | A route-level integration test (`routes/passkey.test.ts`) covering the auth path |
| Batch-13 invoice-handler rollback path | An integration test of `invoice-handler.ts` injecting a failing `enqueueArchiveJob` and asserting the record reverts to `pending` |
| Batch-14 zap-receipt signer mismatch | The new `nostr.test.ts` case (added in batch 14) — already there |
| Batch-15 passkey limit | A `passkey.test.ts` with a registration loop would have surfaced the unbounded growth before the cap shipped |

## Recommended next 3 PRs (in priority order)

1. **`routes/api-v1.test.ts`** — Fastify `inject`-based test of every endpoint's auth gate, rate-limit firing, and error shape. Estimated ~300 lines, ~25 tests. Catches a whole class of "I added a route handler and forgot the rate limit" bugs.
2. **`browser-extension/src/lib/nsec-{store,crypto}.test.ts`** — round-trip + cache-mode + reveal-without-cache. Mock `chrome.storage` with a Map. ~200 lines, ~15 tests. Big morale + confidence win for any future encryption work.
3. **`payment-proxy/src/queue.test.ts`** + **`invoice-handler.test.ts`** — atomic markPaid claim, rollback path, double-callback dedup, underpaid refusal. Mock `ioredis` at the `multi/exec` boundary. ~400 lines, ~20 tests. The financial paths deserve coverage on par with auth.

Total estimated effort: 1–2 focused days. Closes ~80 % of the open-risk surface.
