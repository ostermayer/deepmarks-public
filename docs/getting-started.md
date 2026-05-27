# Getting started

This guide is for someone opening the project for the first time. It
explains what Deepmarks is, how the main pieces fit together, and how
to run enough of it locally to understand the product.

## What Deepmarks does

Deepmarks is a social bookmarking app built on Nostr:

- Public bookmarks are signed `kind:39701` events.
- Private bookmarks are encrypted bookmark-set events.
- Users keep their own identity and can move to other Nostr clients.
- Deepmarks makes the experience feel centralized by indexing,
  searching, syncing settings, and proxying signed publishes through
  its server.

The important privacy model is that clients sign locally, then POST the
already-signed event to the Deepmarks API. The API publishes to
`relay.deepmarks.org` and fans out to the user's relay list. Public
relays see the Deepmarks server IP, not the user's browser or phone IP.

## Repo map

| Path | Purpose |
|---|---|
| `frontend/` | SvelteKit app used by web, iOS, and Android Capacitor shells |
| `browser-extension/` | Chrome, Firefox, and Safari extension source |
| `payment-proxy/` | Fastify API, LNURL, account settings, `/publish`, search, workers |
| `archive-worker/` | Playwright/SingleFile archiver and Blossom mirror worker |
| `bunker/` | NIP-46 signer service for server-owned identities |
| `docs/` | Architecture, protocol, ops, release, and feature guides |

## Run the web app locally

For the normal full dev environment:

```bash
./doctor.sh
./dev.sh
```

Open <http://localhost:5173>. `./dev.sh` starts Redis,
`payment-proxy`, `archive-worker`, and `frontend`.

For UI-only work:

```bash
./dev.sh --web-only
```

For manual service startup, use the top-level
[`README.md`](../README.md#manual-start-per-service).

## Run checks

The fastest confidence pass for app/API work is:

```bash
cd frontend && npm run check && npm test
cd ../payment-proxy && npm run typecheck && npm test
```

Browser extension work should also run:

```bash
cd browser-extension
npm run typecheck
npm test
```

## Browser extension model

The extension is both a save tool and an optional signer. Its default
bookmark publish route matches the web app: sign locally, then POST the
signed event to Deepmarks for server-side relay fan-out. Advanced users
can switch the extension to direct relay publishing from the extension
settings.

See [`extensions.md`](extensions.md) for build details and security
boundaries.

## Mobile status

The iOS and Android Capacitor source is included so the whole system can
be audited and built by contributors. iOS is published on the App Store,
Android is in Play testing and has a Zapstore release flow, and both
native shells share the same signed-event publish model as the web app.
Store-specific payment rules matter: iOS hides Lightning checkout
controls, while web and Android can use BTCPay-hosted upgrade flows. See
[`mobile.md`](mobile.md).

## Next documents to read

1. [`architecture.md`](architecture.md) for the system diagram and Box
   A/B/C responsibilities.
2. [`relay-policy.md`](relay-policy.md) for the server-mediated publish
   and relay fan-out model.
3. [`bookmarks.md`](bookmarks.md) for public/private bookmark behavior.
4. [`settings.md`](settings.md) for synced settings and device-local
   secrets.
5. [`self-host.md`](self-host.md) for running your own instance.
