# Deepmarks tests

All automated tests for every package live in this directory. The layout
mirrors each package's `src/` tree (minus the `src/` segment), plus a
`regression/` directory per package for tests born out of audit findings.

```
tests/
  frontend/            ← SvelteKit web app + Capacitor shells (frontend/)
    lib/…              ← mirrors frontend/src/lib/…
    regression/        ← audit-finding regression guards
  payment-proxy/       ← Box A API (payment-proxy/)
    …, workers/, routes/, feed/, seed/
    regression/
  archive-worker/      ← Box B archiver (archive-worker/)
  browser-extension/   ← Chrome/Firefox/Safari extension (browser-extension/)
    regression/
  bunker/              ← Box C NIP-46 signing service (bunker/)
  run-all.sh           ← runs every package's suite
```

## Running

Each package keeps its own vitest install; its `vitest.config.ts` points the
test scan at the matching subdirectory here.

```sh
./tests/run-all.sh                  # everything
./tests/run-all.sh frontend        # one package
cd frontend && npm test            # same thing, per package
cd frontend && npx vitest run ../tests/frontend/regression   # one directory
cd frontend && npx vitest ../tests/frontend/lib/nostr/feed.test.ts  # watch one file
```

Notes:

- **`node_modules` symlinks.** Each `tests/<package>/node_modules` is a
  committed symlink back to that package's real `node_modules`. Tests live
  outside the package root, so without it bare imports (and `vi.mock`
  module identity) would resolve against the wrong dependency tree. Don't
  delete them; they work on any checkout once the package's
  `npm install` has run.
- **Import style.** Tests import source modules via aliases — `$lib/...`
  (frontend, plus `$src/...` for the rare file outside `src/lib`) and
  `@src/...` (other packages) — never via relative paths into `../src`.
- **Env-gated live suites.** `archive-worker/media-smoke.test.ts` and
  `filetype-smoke.test.ts` hit real network fixtures and are skipped unless
  `DEEPMARKS_MEDIA_SMOKE=1` / `DEEPMARKS_FILETYPE_SMOKE=1` (see file
  headers). Everything else is hermetic — no relay, Redis, or network.

## The `it.fails` convention (known open bugs)

Regression tests for bugs that are **found but not yet fixed** assert the
*correct* behavior and are marked `it.fails`. The suite stays green while
the bug exists, and the moment somebody fixes the bug the test errors with
"expected test to fail" — the fixer then removes the `.fails` marker and
the test becomes a permanent guard. Grep for `it.fails(` to list every
known-open bug with an executable repro. (All findings from the 2026-06
review were fixed in 2.2.0; the tables below are now permanent guards.)

## Regression tests ↔ audit findings (2026-06 review)

Finding IDs refer to the June 2026 reliability review (bookmark publish /
sync / relay durability / private bookmarks / archives).

### `frontend/regression/`

| Test file | Finding | Status | What it guards |
|---|---|---|---|
| `private-set-destructive-rewrite.test.ts` | PRIV-F1 / SYNC-F2 | guard (per-item migration) | Private saves/edits/deletes publish ONE per-item event (`deepmarks-private-item:<sha256>`) and never read or rewrite the chunked set — the wipe/resurrection class is structurally eliminated on the write path. The bulk importer (last whole-set rewrite) keeps the decrypt-failure guard, and the read-side merge still honors tombstones. |
| `pending-publish-dedupe-race.test.ts` | PUB-F7 | guard (fixed 2.2.0) | Acknowledging an older publish must not delete a newer queued edit that shares its (kind, d-tag) dedupe key. Baselines pin enqueue-collapse and self-removal. |
| `replaceable-event-consistency.test.ts` | SYNC-F7 | guard (fixed 2.2.0) | On a `created_at` tie, NIP-01 (and strfry) retain the **lowest** event id — `shouldReplace` (feed.ts) and `shouldReplaceBookmark` (own-bookmarks.ts) now pick the same winner as the relay; `frontend/lib/nostr/feed.test.ts` pins the same direction. |
| | SYNC-F7/F8 | passing | Build→parse round-trip preserves every cross-device-critical field: `published_at`, `published_at_ms` (same-second sort stability), `lightning`, `blossom`, `wayback`, `archive-tier`. |
| `event-resolver-session-retry.test.ts` | NOTE-F1 | guard (fixed 2.2.0) | `resolveEvent` caches a relay miss for the whole session, so a bookmarked kind:1 note that gets mirrored seconds later stays invisible (user reads it as data loss). `primeEvents` retry is already guarded in `lib/nostr/event-resolver.test.ts`. |
| `archive-mirror-fallback.test.ts` | ARCH-A2 | guard (fixed 2.2.0) | When the primary Blossom server 404s, `fetchArchiveBytes` must fall back to the mirrors recorded on the archive record instead of failing on every device. |
| `shared-core-parity.test.ts` | structural | passing | The private-set core (chunk selection incl. cross-version union, per-item selection, tombstone-aware merge) must stay byte-identical between frontend and extension — sha256 comparison of both copies; drift between the two implementations caused the original wipe bug. |
| `archive-crypto-cross-impl.test.ts` | ARCH gap + media v2 | passing | Cross-implementation vector: archive-worker `encryptBlob` (node:crypto) output decrypts with the frontend's `decryptArchiveBlob` (WebCrypto) — layout `[12-byte nonce][ct][16-byte tag]`, base64 key format, GCM tamper/wrong-key rejection, 1 MiB blob. Also pins the chunked v2 media format (`DMCHNK01`, per-chunk AAD binding index + final flag): multi-chunk roundtrip, v1/v2 detection, and rejection of reordered/truncated/tampered chunks. Drift here bricks every paid private/media archive. |
| `signer-timeout.test.ts` | PRIV-F2 | guard (fixed round 2) | Remote-signer (NIP-46/Amber) decrypt/encrypt now time out instead of hanging the private refresh forever; failures are classified (`signer-timeout` vs `nip44-unsupported` vs `wrong-key`) so the bookmarks view can show an actionable banner, and rewrites abort with an explanation. |
| `save-input-normalization.test.ts` | NOTE-F3 | guard (fixed round 2) | Pasting `note1…` / `nevent1…` / `nostr:…` into the save box normalizes to the canonical social URL instead of failing with "Invalid URL". |
| `public-delete-propagation.test.ts` | SYNC-F5 | guard (fixed round 3) | Public deletes propagate across devices: the feed keeps a session deletion memory so a kind:39701 copy arriving after its own kind:5 can't resurrect (and the observer hook prunes the merge-only server cache); forged deletions naming someone else's coordinate are ignored per NIP-09. |
| `archive-key-signer-gate.test.ts` | ARCH-A1 | guard (fixed round 4) | Private/media archive enqueues probe the signer's NIP-44 support first and fail loudly — a signer that can't encrypt used to orphan the AES key in one device's localStorage, leaving the paid archive undecryptable everywhere else. Public archives are not gated. |
| `offline-queue-safety.test.ts` | SYNC-F6 / PUB-F3 | guard (fixed round 3) | Drained replaceable templates are re-stamped to drain time so the relay doesn't discard them as "older"; locked-signer and offline drains don't burn the bounded attempt budget; the bookmarks view shows an "N saves waiting to sync" indicator backed by the reactive `pendingPublishes` store. |

### `browser-extension/regression/`

| Test file | Finding | Status | What it guards |
|---|---|---|---|
| `edit-field-preservation.test.ts` | SYNC-F8 / PUB-F5 / SYNC-F6 | guard (fixed round 3) | Extension edits carry `lightning`/`blossom`/`wayback` through the rebuild — pinned tag-for-tag against the web app's builder via a direct cross-package import; direct-mode publishes that miss the canonical relay queue a retry; queued replaceable events are re-signed at drain time with a valid signature. |
| `private-set-wipe-on-failed-read.test.ts` | EXT-F1 / PRIV-F3 | guard (per-item migration) | The extension's save/delete publish exactly one per-item event (verified down to the decrypted payload), never read the existing set, and never emit `dm-set-version` replacements — the library-wipe class is structurally impossible now. |

### `payment-proxy/regression/`

| Test file | Finding | Status | What it guards |
|---|---|---|---|
| `relay-fanout-retry-classification.test.ts` | RELAY-F1/F5 | guard (fixed 2.2.0 + round 2) | Deterministic strfry policy rejections ("pubkey not registered", "kind not accepted", "too old", future clock skew) must be dead-lettered, not retried 8× as "transient" and silently dropped after the client already got its 202. Rate-limited events get a dedicated 30-attempt budget so bulk imports drain over hours instead of dropping at the generic cap. Baselines pin rate-limit backoff, transient backoff, attempts-exhausted drop. |
| `strfry-write-policy.test.ts` | SYNC-F10 / RELAY-F1 | guard (fixed 2.2.0 + round 2) | Drives `deploy/box-a/strfry/deepmarks.js` as a real subprocess over the strfry plugin line protocol. Private-item delete tombstones (`d=deepmarks-private-item:<hash>`) share the private-state rate budget like the chunks they accompany (in the small general bucket, bulk deletes lost tombstones and deleted bookmarks resurrected). kind:39701 bookmarks get a dedicated env-tunable budget (`STRFRY_BOOKMARK_RATE_LIMIT_PER_HOUR`, default 1000/h) so first-run imports aren't strangled by the 200/h general bucket, and rejected events no longer burn the bucket. Baselines pin the private-state scope and the general limit for non-bookmark kinds. |

## Suite catalog

### frontend (`tests/frontend`, run from `frontend/`)

- `lib/nostr/` — the Nostr core: kind:39701 build/parse + URL safety
  (`bookmarks`), encrypted private set chunking/versioning/tombstones
  (`private-bookmarks`), publish + durable queue (`publish`), save/edit/
  toggle flows (`save-bookmark`, `toggle-read-later`), feeds + dedup +
  deletion handling (`feed`, `feed-cache`), third-party NIP-51 imports
  (`imported-bookmarks`), archives + key map (`archive`, `archive-keys`),
  zaps (`zap`, `zap-invoice`, `bookmark-zap-target`), profiles/friends/
  social (`profiles`, `friends`, `social-*`, `text-refs`), signers
  (`signers/nsec`), note-target resolution (`event-resolver`), NWC
  (`nwc-store`), stats/tag derivations (`user-stats`, `tag-cloud`,
  `popularity*`).
- `lib/api/` — payment-proxy client: NIP-98 auth headers, zod response
  validation, error propagation.
- `lib/archives/` — archive download/zip/filenames (`download`), bookmark
  finalize-after-archive (`finalize`).
- `lib/importers/`, `lib/exporters/` — Pinboard/Pocket/Instapaper/
  Netscape/Raindrop/CSV parsers, batch publish, export round-trips.
- `lib/stores/` — session restore, user settings, theme, my-archives.
- `lib/mobile/nip46-service.test.ts` — the app-as-remote-signer RPC service.
- `lib/search/`, `lib/metadata/`, `lib/util/`, `lib/config.test.ts`,
  `lib/media-archive.test.ts` — local search, link previews, utilities,
  config parsing, media add-on queueing rules.
- `regression/` — see table above.

### payment-proxy (`tests/payment-proxy`, run from `payment-proxy/`)

- Root — route/domain logic: auth + NIP-98 (`auth`), registry +
  onboarding (`registry`), archive purchase/lifecycle/refcount
  (`archive-*`, `lifetime`, `media-archive-addon`, `video-archive`),
  Lightning (`lnurl`, `voltage`, `btcpay`), Blossom auth/storage/mirrors
  (`blossom-*`, `mirror-urls`), search indexing (`search`), public
  bookmark cache + deletion handling (`public-bookmark-cache`), queue
  primitives (`queue`, `redis-exec`), usernames/accounts/api-keys, zap
  validation (`nostr`), favicon proxy, blocklist, metadata.
- `workers/` — relay fanout (`relay-fanout`), zap receipts
  (`zap-listener`), pinboard seeder.
- `feed/`, `seed/`, `routes/` — public feeds (atom/rank/routes), seed
  imports, LNURL proxy.
- `regression/` — see table above (includes the strfry writePolicy
  subprocess tests).

### archive-worker (`tests/archive-worker`, run from `archive-worker/`)

- `crypto.test.ts` — AES-256-GCM blob encryption (layout, tamper, zeroize).
- `worker.test.ts` — job lifecycle: verify-then-mirror-then-notify
  ordering, permanent vs retryable media failures, audit-pass summaries,
  stale-job requeue, account-index recognition.
- `queue.test.ts` — crash-safe BLMOVE queue + orphan recovery.
- `blossom.test.ts`, `mirror-targets.test.ts` — upload/mirror fanout.
- `youtube`-adjacent: `podcast`, `direct-file`, `scholarly`, `wayback`,
  `strip-selectors`, `safe-url`.
- `media-smoke.test.ts`, `filetype-smoke.test.ts` — env-gated live fixtures.

### bunker (`tests/bunker`, run from `bunker/`)

- `nip46.test.ts`, `handler.test.ts` — NIP-46 request parsing + method
  dispatch for the remote-signing service.
- `vault.test.ts` — encrypted nsec vault storage.
- `permissions.test.ts` — per-app signing permission grants.
- `audit.test.ts` — signing audit log.

### browser-extension (`tests/browser-extension`, run from `browser-extension/`)

- `lib/nostr.test.ts` — bookmark/social templates, publish + delete flows,
  NIP-65 relay discovery, deletion filtering.
- `lib/nsec-store.test.ts`, `lib/nsec-backup.test.ts` — key storage,
  passkey lock, corrupt-key handling, encrypted backup.
- `lib/nwc-store.test.ts` — Nostr Wallet Connect storage.
- `popup/screens/popup-drafts.test.ts` — draft persistence across popup
  closes.
- `regression/` — see table above.

## Adding tests

1. Put the file in `tests/<package>/<mirrored source path>`, or
   `tests/<package>/regression/` if it documents a bug/finding.
2. Import sources via the alias (`$lib/...` or `@src/...`).
3. If the bug is not fixed yet, assert the **correct** behavior and mark
   the test `it.fails` with a comment naming the finding; fix-time flips
   it into a permanent guard.
4. Keep tests hermetic: mock `$lib/nostr/ndk.js` / `@src/lib/nostr.js`
   at module level (see existing files for the house pattern), stub
   `localStorage`/`fetch` with `vi.stubGlobal`, and never touch real
   relays or Redis.
