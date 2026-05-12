# Deepmarks frontend

SvelteKit + TypeScript SPA. Targets Cloudflare Pages (static adapter, no SSR).
The browser talks straight to relays, Blossom, and the payment-proxy — there is no
intermediate server.

## Run locally

```bash
npm install
cp .env.example .env   # edit if pointing at non-prod endpoints
npm run dev            # http://localhost:5173
npm test               # vitest run
npm run check          # svelte-check
```

## Build

```bash
npm run build          # → ./build  (static, deploy to Cloudflare Pages)
npm run preview        # serve the build locally
```

## Layout

```
src/
├── app.html              page shell + pre-paint theme bootstrap
├── app.css               design tokens (copied verbatim from MVP/deepmarks/*.html)
├── lib/
│   ├── config.ts         all VITE_* env reads in one place; Deepmarks owned pubkeys
│   ├── api/
│   │   ├── client.ts     payment-proxy HTTP client + account/archive/api.keys schemas
│   │   └── keys.test.ts  NIP-98 header round-trip + keys CRUD tests
│   ├── components/       Logo · Header · Footer · Subheader · SaveBox · BookmarkCard ·
│   │                     Sidebar · BookmarkList · ZapDialog · ArchiveDialog · ApiKeysSection
│   ├── stores/           theme · session · own-bookmarks (with tests)
│   ├── search/           local personal bookmark search helper + tests
│   ├── util/
│   │   └── time.ts       relativeTime() shared across components
│   ├── nostr/
│   │   ├── kinds.ts      kind:0 / 1 / 5 / 9734 / 9735 / 10002 / 10063 / 30003 / 39701
│   │   ├── ndk.ts        shared NDK pool + whenReady()
│   │   ├── bookmarks.ts  build / parse kind:39701 events with the CLAUDE.md tag schema
│   │   ├── feed-cache.ts synchronous first-paint feed cache helpers
│   │   ├── feed.ts       live subscription store with NIP-01 dedup tiebreaker
│   │   ├── publish.ts    NDKEvent wrapper with replaceable-kind detection
│   │   ├── private-bookmarks.ts NIP-44 v2 encrypt-to-self + tagged DecryptResult
│   │   ├── zap.ts        single-recipient zap plan + kind:9734 tag builder + WebLN payment
│   │   ├── archive.ts    lifetime enqueue, local queue markers, status helpers
│   │   ├── lifetime-archive-backfill.ts lifetime backfill + /account/archive-queue polling
│   │   ├── deepmarks-extension.ts first-party extension signer detection/refresh
│   │   └── signers/      NIP-07 (browser ext) · NIP-46 (bunker) · nsec (in-memory)
│   ├── importers/        netscape · pinboard · pocket · instapaper · raindrop · batch-publish
│   ├── exporters/        netscape · pinboard · csv · jsonl · downloadAsFile
│   └── data/sample.ts    seed bookmarks (UI fallback when relays are empty)
└── routes/
    ├── /                 landing
    ├── /pricing          tiered pricing + FAQ
    ├── /signup           5-step onboarding (welcome → branch → identity → profile → signer)
    ├── /login            4 sign-in methods (extension, NIP-46, nsec, email)
    └── /app              authed shell with header + nav + sidebar
        ├── /             compatibility redirect to /app/bookmarks
        ├── /bookmarks    your Deepmarks bookmarks
        ├── /posts        Nostr social bookmarks/posts
        ├── /network      everyone's bookmarks
        ├── /popular      sorted by save count
        ├── /recent       sorted by created_at
        ├── /tags         tag cloud
        ├── /tags/[tag]   bookmarks for one tag
        ├── /search       personal search by default; global public toggle
        ├── /settings     profile · theme · relays · archive · **api access** · sign out
        ├── /import       Pinboard / del.icio.us / Pocket / Instapaper / Raindrop / Netscape
        └── /export       Netscape HTML / Pinboard JSON / CSV / raw Nostr .jsonl
```

## What's wired up

- ✅ Theme system (light · dark · auto) with FOUC-free pre-paint
- ✅ Header search with `/` shortcut; personal bookmarks by default, global public search toggle
- ✅ Profile dropdown (settings · import · export · theme · logout)
- ✅ Signup flow (generates an in-browser keypair, shows recovery key + public identity, and offers passkey protection)
- ✅ Login flow with passkey, NIP-07, NIP-46 remote signer, and recovery-key signers
- ✅ Save box with metadata fetch, public + private (NIP-44 v2) save paths
- ✅ Zap dialog with single-recipient WebLN + invoice / QR payment
- ✅ Lifetime archive queue/backfill status with server backlog polling
- ✅ Compact archive icon on completed bookmark rows; pending work stays in archived-only progress UI
- ✅ Full import/export with 5 source formats + 4 export formats (round-trip proofs)
- ✅ Import progress that counts private-set publish work and seeds `/app/bookmarks` immediately
- ✅ Bookmark/profile/search lists render 50 rows at a time with load-more controls
- ✅ Live NDK feed subscriptions with NIP-01 tiebreak-by-event-id dedup
- ✅ **API key management** in settings (create / copy-once / list / revoke) for lifetime members
- ✅ PWA manifest

## Known gaps

- 🟡 Relay-list editor backed by NIP-65 kind:10002
- 🟡 Browser-extension tests live in the extension package, not the frontend suite

## Conventions

- All env reads live in `src/lib/config.ts` (CLAUDE.md rule). The brand/social key (`npub199…`) now signs the once-daily Pinboard bookmark and the landing feed follows that key; the old admin seeder key (`npub10…`) remains a legacy editorial key for attribution filtering.
- Tailwind tokens reference CSS variables so dark mode works without rebuilding classes.
- Recovery-key sign-in can persist the decoded nsec in this browser when the user chooses that usability tradeoff. Browser-extension signing remains the recommended key-isolation path.
- nsec values are decoded with `nostr-tools`. Passkey sessions persist server-side ciphertext plus WebAuthn credential metadata; recovery-key sessions may also persist a local nsec for refresh/back/forward continuity.
- Every module has a co-located `*.test.ts`; run `npm test` to verify.

## API surface

The `api.*` namespace in `src/lib/api/client.ts` is the only path between frontend and
payment-proxy. Every response is parsed through a `zod` schema — a backend that drifts
will throw `ApiValidationError` rather than poisoning the UI with garbage.

`api.keys.*` uses NIP-98 auth (`buildNip98AuthHeader`) and is consumed by
`lib/components/ApiKeysSection.svelte` under `/app/settings`. See
[`../docs/api-v1.md`](../docs/api-v1.md) for the full API reference.
