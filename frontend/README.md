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
├── app.css               production design tokens
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
│   │   ├── bookmarks.ts  build / parse kind:39701 events with the Deepmarks tag schema
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

## Product surface

| Area | Implementation |
|---|---|
| Theme | Light, dark, and auto modes with pre-paint theme bootstrap to avoid FOUC |
| Search | Header search with `/` shortcut; personal bookmarks by default and an explicit global public toggle |
| Navigation | Web profile dropdown; native apps use bottom tabs instead of the avatar menu |
| Signup | In-browser keypair generation, recovery key, public identity, passkey protection, text backup, and QR export |
| Login | Passkey, NIP-07, NIP-46 remote signer, Deepmarks phone signer pairing, Android signer, and recovery-key signers |
| Saving | Metadata fetch, public `kind:39701` saves, private NIP-44 bookmark sets, and mobile share-sheet drain |
| Zaps | Single-recipient WebLN, NWC, invoice, and QR payment paths |
| Wallet sync | NWC credentials stored as a self-encrypted `kind:30003` record with `d=deepmarks-nwc` |
| Archives | Lifetime archive queue/backfill status, completed archive indicators, and private media archive add-on status |
| Import/export | Netscape, Pinboard, Pocket, Instapaper, Raindrop, CSV, JSONL, and round-trip proof coverage |
| Lists | Bookmark, profile, search, and friends lists page 50 rows at a time with load-more controls |
| Mobile | Native bottom tab bar for bookmarks, friends, search, save, tags, and overflow destinations |
| Feeds | Live NDK feed subscriptions with NIP-01 tiebreak-by-event-id dedup |
| API keys | Lifetime-member API key management in settings: create, copy-once, list, and revoke |
| PWA | Static manifest and installable web build |

## Known gaps

- Relay-list editor is backed by NIP-65 kind:10002.
- Native push notifications are not shipped yet; mobile settings mark push as coming soon.
- Browser-extension tests live in the extension package, not the frontend suite.

## Conventions

- All env reads live in `src/lib/config.ts`. The brand/social key (`npub199…`) now signs the once-daily Pinboard bookmark and the landing feed follows that key; the old admin seeder key (`npub10…`) remains a legacy editorial key for attribution filtering.
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
