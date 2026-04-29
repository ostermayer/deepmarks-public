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
│   ├── config.ts         all VITE_* env reads in one place; assertDeepmarksPubkey()
│   ├── api/
│   │   ├── client.ts     payment-proxy HTTP client + api.keys.* with zod response schemas
│   │   └── keys.test.ts  NIP-98 header round-trip + keys CRUD tests
│   ├── components/       Logo · Header · Footer · Subheader · SaveBox · BookmarkCard ·
│   │                     Sidebar · BookmarkList · ZapDialog · ArchiveDialog · ApiKeysSection
│   ├── stores/           theme · session (with tests)
│   ├── util/
│   │   └── time.ts       relativeTime() shared across components
│   ├── nostr/
│   │   ├── kinds.ts      kind:0 / 1 / 5 / 9734 / 9735 / 10002 / 10063 / 30003 / 39701
│   │   ├── ndk.ts        shared NDK pool + whenReady()
│   │   ├── bookmarks.ts  build / parse kind:39701 events with the CLAUDE.md tag schema
│   │   ├── feed.ts       live subscription store with NIP-01 dedup tiebreaker
│   │   ├── publish.ts    NDKEvent wrapper with replaceable-kind detection
│   │   ├── private-bookmarks.ts NIP-44 v2 encrypt-to-self + tagged DecryptResult
│   │   ├── zap.ts        3-way split + kind:9734 tag builder + WebLN payment
│   │   ├── archive.ts    invoice → WebLN → poll state machine
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
        ├── /             your marks (default)
        ├── /network      everyone's bookmarks
        ├── /popular      sorted by save count
        ├── /recent       sorted by created_at
        ├── /tags         tag cloud
        ├── /tags/[tag]   bookmarks for one tag
        ├── /search       unified search (client + server-side)
        ├── /settings     profile · theme · relays · archive · **api access** · sign out
        ├── /import       Pinboard / del.icio.us / Pocket / Instapaper / Raindrop / Netscape
        └── /export       Netscape HTML / Pinboard JSON / CSV / raw Nostr .jsonl
```

## What's wired up

- ✅ Theme system (light · dark · auto) with FOUC-free pre-paint
- ✅ Header search with `/` global shortcut
- ✅ Profile dropdown (settings · import · export · theme · logout)
- ✅ Signup flow (generates an in-browser keypair, shows nsec + npub once)
- ✅ Login flow with NIP-07, NIP-46 bunker, and nsec signers
- ✅ Save box with metadata fetch, public + private (NIP-44 v2) save paths
- ✅ Zap dialog with 3-way split + WebLN payment
- ✅ Archive purchase dialog (WebLN + status polling)
- ✅ Full import/export with 5 source formats + 4 export formats (round-trip proofs)
- ✅ Live NDK feed subscriptions with NIP-01 tiebreak-by-event-id dedup
- ✅ **API key management** in settings (create / copy-once / list / revoke) for lifetime members
- ✅ PWA manifest

## What's stubbed

- 🟡 Server-side Meilisearch ranking on `/search` (falls back to client-side feed filter)
- 🟡 kind:0 profile resolution for the zap-split curator label
- 🟡 Relay-list editor backed by NIP-65 kind:10002

## Conventions

- All env reads live in `src/lib/config.ts` (CLAUDE.md rule). `assertDeepmarksPubkey()` fail-fasts when the brand pubkey isn't configured, so zap-receipt verification can't silently succeed against `''`.
- Tailwind tokens reference CSS variables so dark mode works without rebuilding classes.
- **No `localStorage` for secrets** — only the session hint (signer kind + npub) is persisted.
- nsec values are decoded with `nostr-tools` and held as `Uint8Array` in closure scope.
- Every module has a co-located `*.test.ts`; run `npm test` to verify.

## API surface

The `api.*` namespace in `src/lib/api/client.ts` is the only path between frontend and
payment-proxy. Every response is parsed through a `zod` schema — a backend that drifts
will throw `ApiValidationError` rather than poisoning the UI with garbage.

`api.keys.*` uses NIP-98 auth (`buildNip98AuthHeader`) and is consumed by
`lib/components/ApiKeysSection.svelte` under `/app/settings`. See
[`../docs/api-v1.md`](../docs/api-v1.md) for the full API reference.
