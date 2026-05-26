# Deepmarks frontend

SvelteKit + TypeScript SPA. Targets Cloudflare Pages (static adapter, no SSR)
and is also the web bundle wrapped by the iOS and Android Capacitor shells.
Clients sign user events locally, POST writes through payment-proxy's
`/publish` endpoint, and read from relays / Blossom as needed.

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
│   │                     Sidebar · BookmarkList · ZapDialog · ArchiveDialog · AddOnsSection
│   │                     NativeTabBar · ApiKeysSection
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
│   │   ├── publish.ts    local sign + POST /publish helper with durable retry
│   │   ├── private-bookmarks.ts NIP-44 v2 encrypt-to-self + tagged DecryptResult
│   │   ├── zap.ts        single-recipient zap plan + kind:9734 tag builder + WebLN payment
│   │   ├── archive.ts    lifetime enqueue, local queue markers, status helpers
│   │   ├── lifetime-archive-backfill.ts lifetime backfill + /account/archive-queue polling
│   │   ├── deepmarks-extension.ts first-party extension signer detection/refresh
│   │   └── signers/      NIP-07 (browser ext) · NIP-46 (bunker) · nsec (in-memory)
│   ├── media-archive.ts  paid media add-on detection + queueing
│   ├── mobile/           share-sheet drain, QR scanner, secure-store helpers
│   ├── importers/        netscape · pinboard · pocket · instapaper · raindrop · batch-publish
│   ├── exporters/        netscape · pinboard · csv · jsonl · downloadAsFile
│   └── data/sample.ts    seed bookmarks (UI fallback when relays are empty)
└── routes/
    ├── /                 landing
    ├── /pricing          tiered pricing + FAQ
    ├── /signup           5-step onboarding (welcome → branch → identity → profile → signer)
    ├── /login            4 sign-in methods (extension, NIP-46, nsec, email)
    └── /app              authed shell with header + nav + sidebar/native tabs
        ├── /             compatibility redirect to /app/bookmarks
        ├── /bookmarks    your Deepmarks bookmarks
        ├── /friends      selected friends' Deepmarks bookmarks + link-only Nostr posts
        ├── /posts        kind:1 / NIP-51 social bookmark references
        ├── /save         mobile-first save page
        ├── /tags         personal tags only (list/cloud)
        ├── /tags/[tag]   your bookmarks for one tag
        ├── /explore      global public bookmarks + global tags
        ├── /network      everyone's bookmarks
        ├── /popular      sorted by save count
        ├── /recent       sorted by created_at
        ├── /search       personal search by default; global public toggle
        ├── /settings     key/profile/wallet/defaults/add-ons/advanced/api/sign out
        ├── /upgrade      BTCPay lifetime checkout (web + Android)
        ├── /archives     completed archive list
        ├── /mobile-signer native signer pairing entry
        ├── /zaps         zap activity
        ├── /import       Pinboard / del.icio.us / Pocket / Instapaper / Raindrop / Netscape
        └── /export       Netscape HTML / Pinboard JSON / CSV / raw Nostr .jsonl
    ├── /apps             iOS app + Android status + Chrome/Firefox links
    ├── /api              public API explainer
    ├── /privacy          privacy policy
    ├── /support          support page
    └── /u/[slug]         public profile
```

## What's wired up

- ✅ Theme system (light · dark · auto) with FOUC-free pre-paint
- ✅ Header search with `/` shortcut; personal bookmarks by default, global public search toggle
- ✅ Web profile dropdown; native apps navigate through bottom tabs instead of the avatar menu
- ✅ Signup flow (generates an in-browser keypair, shows recovery key + public identity, offers passkey protection, and exports a text backup with QR)
- ✅ Login flow with passkey, NIP-07, NIP-46 remote signer, Deepmarks phone signer pairing, and recovery-key signers
- ✅ Save box with metadata fetch, public + private (NIP-44 v2) save paths
- ✅ Zap dialog with single-recipient WebLN + invoice / QR payment
- ✅ NWC sync as a self-encrypted `kind:30003` record (`d=deepmarks-nwc`)
- ✅ Lifetime archive queue/backfill status with server backlog polling
- ✅ Compact archive icon on completed bookmark rows; pending work stays in archived-only progress UI
- ✅ Media archive add-on status, hosted checkout on web/Android, and automatic private media queueing
- ✅ Full import/export with 5 source formats + 4 export formats (round-trip proofs)
- ✅ Import progress that counts private-set publish work and seeds `/app/bookmarks` immediately
- ✅ Bookmark/profile/search lists render 50 rows at a time with load-more controls
- ✅ Native bottom tab bar: bookmarks, friends, search, save, tags, and more; more opens explore/settings
- ✅ Live NDK feed subscriptions with NIP-01 tiebreak-by-event-id dedup
- ✅ **API key management** in settings (create / copy-once / list / revoke) for lifetime members
- ✅ PWA manifest

## Known gaps

- ✅ Relay-list editor backed by NIP-65 kind:10002
- 🟡 Native push notifications are not shipped yet; mobile settings mark push as coming soon
- 🟡 Browser-extension tests live in the extension package, not the frontend suite

## Conventions

- All env reads live in `src/lib/config.ts` (CLAUDE.md rule). The brand/social key (`npub199…`) now signs the once-daily Pinboard bookmark and the landing feed follows that key; the old admin seeder key (`npub10…`) remains a legacy editorial key for attribution filtering.
- Tailwind tokens reference CSS variables so dark mode works without rebuilding classes.
- Recovery-key sign-in can persist the decoded nsec in this browser when the user chooses that usability tradeoff. Browser-extension signing remains the recommended key-isolation path.
- Mobile recovery-key import can scan nsec QR codes from Deepmarks backup text or settings screens; camera logic is shared through `src/lib/mobile/qr-scanner.ts`.
- nsec values are decoded with `nostr-tools`. Passkey sessions persist server-side ciphertext plus WebAuthn credential metadata; recovery-key sessions may also persist a local nsec for refresh/back/forward continuity.
- Server-synced account settings go through `/account/settings`; NWC wallet credentials are excluded from that plaintext settings document and sync through a separate self-encrypted Nostr record.
- Every module has a co-located `*.test.ts`; run `npm test` to verify.

## API surface

The `api.*` namespace in `src/lib/api/client.ts` is the only path between frontend and
payment-proxy. Every response is parsed through a `zod` schema — a backend that drifts
will throw `ApiValidationError` rather than poisoning the UI with garbage.

`api.keys.*` uses NIP-98 auth (`buildNip98AuthHeader`) and is consumed by
`lib/components/ApiKeysSection.svelte` under `/app/settings`. See
[`../docs/api-v1.md`](../docs/api-v1.md) for the full API reference.
