# Full-codebase robustness review — 2026-08-23

Multi-agent adversarially-verified review of `api/src`, `archive-worker/src`,
`frontend/src/lib`, and `bunker/src` at HEAD (`c76072e`), followed by a
same-day fix pass. ~40 defects survived verification; the confirmed ones were
fixed in four package batches, each with pinning tests, full package suites +
typecheck, and a live deploy check (fix commits `4e116f9` api, `a51774e`
archive-worker, `fc6e80f` frontend, `6ab339a` bunker; the nsec login trio was
fixed earlier in `ffb636c` web + extension v2.2.10). This file records what
changed and what was deliberately deferred.

## Fixed (highlights — see the four commit messages for the full list)

**api** — BTCPay webhook 500s+alerts on processing failure so a paid
settlement can't be silently dropped; Meili counter flushes use partial
update (full-doc replace was wiping indexed bookmarks on every save/zap);
worker relay pools reconnect + resubscribe (a strfry restart used to kill
every subscription silently); search/api-v1 delist filtering reads the key
admin delisting actually writes (takedown bypass); attribution seed-hide and
popularity dedupe compare canonical URLs; search indexer rejects
non-http(s) d-tags (stored XSS); fanout rate-limit counter created
atomically with TTL + self-heal; /archive/status falls back to 30-day job
metadata; failure-record clear-tombstone (success can't be resurrected by a
racing failure write); alerter releases its dedup claim on send failure;
kind:1 fanout got the crash-safe BLMOVE + recovery shape; follows cursor
stamps query-start; onboarding empty scans retry in 24h; zap-listener
per-receipt dedup; lnurl callback requires the 9734 p-tag to match the
address's receipt signer; media enqueue releases its claim on create
failure; profile cache never rolls back to an older kind:0.

**archive-worker** — stale-path Wayback rescue gated on a reliable live-job
scan (a truncated scan let the audit overwrite an in-flight live render
with a stale snapshot, permanently); chunked-encryption and to-disk
download flushes surface ENOSPC on the success path (silently truncated
"verified" archives); lease heartbeat SET-recreates instead of EXPIRE
(orphaned leases + the false "supervisor reclaims" comment); to-disk
downloads assert non-truncation like the in-memory twin; temp-dir leak on
non-media probes; sidecar stat-before-read (OOM guard); the three false
"safeFetch pins the IP" comments corrected.

**frontend** — logout invalidates in-flight session restore (it used to
re-mirror the nsec into the iOS shared Keychain and sign back in); the
NIP-46 mobile signer no longer accepts permission self-escalation via
`connect`; contacts/friends/mute mutations refuse to republish over an
unloaded list (fetch errors used to let follow() replace the whole kind:3
with one p-tag); toggle-read-later failure genuinely rolls back; Blossom
uploads verify content addressing; zap requests carry the `a` coordinate
for kind:39701; NIP-01 lowest-id tie-breaks; importer/id-normalization
fixes. (Signer/session-surface changes ⇒ per the client-fix release gate,
native builds are stale until a 2.2.13/build-43 ships.)

**bunker** — unauthorized-flood audit writes bounded (one aggregated entry
per 10s); reconnect replay bounded (`since` on the REQ + processed-id
dedup — the bunker used to re-sign the client's recent requests on every
reconnect).

## Deliberately deferred (design follow-ups, not quick fixes)

| Item | Why deferred | Sketch |
|---|---|---|
| Renderer subresource SSRF (no connect pinning; Chromium re-resolves) | Routing Chromium through a proxy risks breaking all rendering; needs its own tested change | Launch with `--proxy-server` at the existing safe-http-proxy, or in-renderer request interception with pinned sockets |
| archive-refcount delete race | Lua can't close it (race is between count-0 and the physical delete); documented in-code | Delete-tombstone consulted by the content-address dedupe path so a racing add re-uploads |
| LND invoice listener backlog | Payment-path plumbing; prod is lifetime-only (BTCPay path has webhook redelivery) | Persist `settle_index`, pass as cursor on subscribe |
| Zap-total aggregation by `a` coordinate | Cross-surface migration (server totals keyed by event id) | Aggregate receipts by address for 39701 targets; requests now carry the tag |
| `accounts.create()` dead subsystem | **Resolved 2026-08-23**: it is the orphaned remnant of the email/magic-link login removed when passkey storage shipped (docs/login.md) — not payment-proxy state. The one live casualty (API-key mint gated on the dead store, 402ing every paid member) is fixed in `1c5b8d9` (gates on lifetimeStore). | The dead surfaces were removed in `20e42b3` (email-JWT sessions, private-marks routes, `/relay/check-pubkey`, the whole account store + jsonwebtoken dep) and the removal itself passed an adversarial diff review; the one cross-repo regression it found (clients requiring two deleted DELETE /account response fields) is fixed with server compatibility constants + optionalized client schema |
| `popular-tags` MIN_DISTINCT_AUTHORS=1 no-op | Comment vs constant contradict; either change alters product output | Operator picks: fix the constant (≥2) or the comment |
| Bunker audit fail-open + kind-9735 sign gate | PLAUSIBLE-grade; fail-closed audit trades availability, 9735 gating is a product call | Append-before-respond for signing methods; deny 9735 unless a bunker client legitimately mints receipts |

## Simplification backlog (apply only with the pinning coverage noted)

- ~~Extract `safe-url.ts` to a shared package~~ **Done 2026-08-23**: the
  predicate core (UnsafeUrlError/looksLikeIp/isPrivateIp/embeddedIpv4) is
  canonical at `packages/safe-url-core/` and synced into checked-in copies
  (`node scripts/sync-shared-modules.mjs`; Docker build contexts are
  per-package, so a runtime workspace dep can't reach the images). A parity
  test in each suite fails on drift. Note: the two files were NOT
  check-for-check identical as first reported — only the predicates were;
  each package's higher-level guard (validate/assert/safeFetch/redirect
  policy) differs by design and stays per-package.
- ~~Shared queue/wire types (worker `ArchiveJob`/`ArchiveFileRecord` ⇄ api
  `types.ts` — already drifted once into the `done:undefined` incident)~~
  **Done 2026-08-23**: `ArchiveJob`/`ArchiveFileRecord`/`ArchiveDeleteJob`
  are canonical at `packages/archive-wire/` under the same generated-copy
  scheme (the sync script is now manifest-driven, and the per-suite
  `shared-module-parity` tests cover every module in the manifest). The
  unification surfaced and closed a live drift: the worker's `ArchiveJob`
  was missing `eventId` (runtime was saved only by whole-object
  reserialization on requeue). api-side `ArchiveJobMetadata` is now a
  `Pick` of `ArchiveJob`, so the third near-copy of the field list can't
  drift either. Deliberately NOT unified: the `/archive/callback` payload
  (the api's zod `ArchiveCallbackSchema` is the runtime authority) and
  `DoneRecord` (worker-internal; the api reads done records defensively).
- ~~One `settleArchivePurchase` path for the three hand-rolled
  create→markPaid→enqueue→rollback copies~~ **Done 2026-08-23**: the
  shared core is `markPaidAndEnqueue` (purchase-settlement.ts) — markPaid
  → enqueue → rollback-on-failure, returning a discriminated result so
  webhook callers (`settleArchivePurchase`, unchanged contract: absorb +
  alert) and HTTP routes (lifetime direct enqueue, media add-on: rethrow
  the original error, release the pending claim) keep their exact
  external behavior. Pinned first: `tests/api/purchase-settlement.test.ts`
  was written against the pre-refactor behavior (4 settle pins, green
  before and after) plus 4 core pins. Only invisible delta: on enqueue
  failure the rollback now runs before the warning alert is issued
  (alerts were already fire-and-forget).
- ~~Extract the 5× upload→verify→mirror→record tail in `worker.ts`~~
  **Done 2026-08-24**: `verifyAndMirror` (worker.ts) is the one
  verify → mirror fanout → merge-rejections → park-failed-legs tail,
  used by all five capture paths (webpage primary, Wayback rescue,
  scholarly PDF, media primary, media sidecars). Discriminated result
  keeps each site's verify-failure semantics (retryable throw / skip /
  drop-sidecar) and audit vocabulary caller-side; `announce` carries the
  loud paths' verified/mirrored/mirror-skipped trail; `targets` is
  pre-resolved (PDF/sidecars) or resolved in the helper after verify
  (order preserved). Upload calls stay per-site (parallel-with-
  screenshot, file-vs-memory forms differ by design). Worker suite 154
  green (pins verify/mirror args, mirrorFile-vs-mirror choice, mirrors
  payloads), tsc clean.
- ~~Quintuplicated YouTube-ID parser~~ **Done 2026-08-24**: canonical at
  `packages/youtube-id/` (parser + host predicate + ID guard), synced
  into api, archive-worker, frontend, and browser-extension under the
  shared-modules scheme (the api/worker parity suites check all four
  copies). The unification surfaced real drift: the frontend/extension
  media-archive copies accepted `?v=<id>` on ANY youtube.com path (a
  playlist URL could be misdetected as a single video, disagreeing with
  the server), and a sixth variant in `my-archives.ts` was the only one
  accepting youtube-nocookie.com. Canonical semantics are the server's,
  extended with the nocookie embed domain; `isYoutubeHost` deliberately
  keeps the pre-unification primary-domain scope for the renderer
  bot-wall and media-URL gates. The one composite regex left inline is
  routes/archive.ts `videoContentKey` (compound `yt:|video:` format
  validation, not a parser). The post-refactor adversarial review caught
  one real regression — the replaced media-archive gates www-stripped
  before comparing, the shared `isYoutubeHost` didn't, so
  `www.youtu.be` silently dropped out of media detection — fixed by
  www-stripping in the canonical predicate with a gate/parser-agreement
  pin. The same review surfaced two pre-existing items now also fixed:
  the extension's `mediaArchiveIdentity` still case-collapsed video ids
  (the frontend twin was fixed 2026-08-23, the extension copy missed —
  aligned, test pins flipped to case-preserving) and
  api/video-archive.ts held a seventh private host predicate (deduped).
- ~~Dead code list~~ **Done 2026-08-24**: removed the worker's
  `stageBlob`/`unstageBlob` chain (KEYS.staged + STAGED_BLOB_TTL_SECONDS
  config, compose env, and doc mentions — nothing ever staged);
  `residentialSourceIpFor` + the RESIDENTIAL_ALWAYS_DOMAINS machinery
  (never gained a production caller — the live wiring is youtube.ts's
  explicit fallback on `residentialSourceIp`, which stays tested);
  follows-ingester's never-used `blockingRedis` (was holding a real idle
  Redis connection per worker); and `queryWithTimeout`'s vestigial
  `_pool` parameter plus the SimplePool instances that existed only to
  feed it — follows-ingester `outboundPool`, onboarding-scanner
  `this.pool`, and lifetime-backfill `this.pool` (its shutdown guard
  now reads the existing `stopping` flag; onboarding's `outbound`
  publish pool and follows-ingester's contacts/local pools are live and
  kept). Suites green after each cut.
