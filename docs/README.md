# Deepmarks docs

Operator-facing references for running Deepmarks. Historical design
specs and HTML mockups remain in [`MVP/deepmarks/`](../MVP/deepmarks/),
but production behavior is captured here and in the component READMEs.

| File | Topic |
|---|---|
| [`getting-started.md`](getting-started.md) | First-read project overview, local run tutorial, publish model, mobile release status |
| [`self-host.md`](self-host.md) | Run your own Deepmarks instance, optional services, app endpoints, Box A/B/C roles |
| [`architecture.md`](architecture.md) | Host layout (Box A/B/C), services, data flow, DNS/TLS, persistence, Cloud Firewall |
| [`relay-policy.md`](relay-policy.md) | Server-mediated publish model, registered-pubkey writePolicy, server-side fan-out worker, onboarding scan, lifetime-archive backfill |
| [`event-kinds.md`](event-kinds.md) | Field-by-field shape of the three Nostr kinds Deepmarks uses for bookmarks (kind:39701 / 30003 / 10003) |
| [`push-notifications.md`](push-notifications.md) | Web Push architecture, VAPID setup, vendor mapping (FCM / Mozilla Autopush / APNs), privacy boundaries, iOS Capacitor gap |
| [`bookmarks.md`](bookmarks.md) | Public/private bookmark model, personal library, edit/delete, visibility changes |
| [`read-later.md`](read-later.md) | `toread` tag convention, section tab, default toggle, sync |
| [`durable-publish.md`](durable-publish.md) | localStorage retry queue, drain triggers, re-sync recovery flow |
| [`search.md`](search.md) | Personal search default, global search toggle, query modifiers, freshness model |
| [`import-export.md`](import-export.md) | Import formats, review flow, accurate progress, immediate bookmark visibility, export |
| [`archives.md`](archives.md) | Lifetime archive UX, worker flow, Blossom fanout, archive-keys chunking, per-page and zip downloads, cross-user refcount dedup |
| [`add-ons.md`](add-ons.md) | Paid extras layered on top of lifetime — YouTube video archive (150k sats, 720p, VP9+Opus in MKV) and the framework for adding more |
| [`zaps.md`](zaps.md) | Bookmark zap recipient selection, NWC/invoice paths, receipt ownership |
| [`settings.md`](settings.md) | Account/recovery settings, NWC, relays, Blossom backups, lifetime/API controls |
| [`extensions.md`](extensions.md) | Chrome/Firefox/Safari extension behavior, signer mode, NWC/WebLN, package layout |
| [`mobile.md`](mobile.md) | Mobile app account/bookmark behavior, app-store payment constraints, signer goal |
| [`release.md`](release.md) | Public mirror, GPL, Android/iOS, and Zapstore release checklist |
| [`zapstore.md`](zapstore.md) | Android APK build and Zapstore publish checklist |
| [`lightning.md`](lightning.md) | Voltage, BTCPay, bookmark zaps, lifetime tier, multi-LN addresses |
| [`nostr.md`](nostr.md) | Every event kind we touch, NIP compliance, identities, bunker-backed signing, citizenship rules |
| [`login.md`](login.md) | Sign-in paths (passkey / extension / remote signer / recovery key), WebAuthn + PRF + ciphertext storage, threat model |
| [`bunker.md`](bunker.md) | NIP-46 signing service on Box C — permission allowlist, wire protocol, rotation |
| [`admin.md`](admin.md) | Admin auth (NIP-98), CLI, recovery playbooks, threat model |
| [`api-v1.md`](api-v1.md) | Public REST API for lifetime-tier members |
| [`releases/v0.6.0.md`](releases/v0.6.0.md) | Public release notes for v0.6.0 |

Top-level project [README](../README.md) covers quickstart + repo
layout. Per-component READMEs document dev-time ergonomics:

- [`frontend/README.md`](../frontend/README.md)
- [`payment-proxy/README.md`](../payment-proxy/README.md)
- [`archive-worker/README.md`](../archive-worker/README.md)
- [`bunker/README.md`](../bunker/README.md)
- [`deploy/README.md`](../deploy/README.md)
