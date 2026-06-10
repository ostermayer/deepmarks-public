# Deepmarks docs

Operator-facing references for running Deepmarks. Production behavior is
captured here and in the component READMEs.
Release notes are split by stream: `v0.x` notes are public source/server
releases, Android notes are installed Android/Zapstore releases, and
older `v2.x` or `extension-v...` notes are historical client-aligned
records retained for context.

| File | Topic |
|---|---|
| [`system-overview.md`](system-overview.md) | High-level product, Nostr, archive, and three-box deployment diagrams |
| [`getting-started.md`](getting-started.md) | First-read project overview, local run tutorial, publish model, mobile release status |
| [`self-host.md`](self-host.md) | Run your own Deepmarks instance, optional services, app endpoints, Box A/B/C roles |
| [`architecture.md`](architecture.md) | Host layout (Box A/B/C), services, data flow, DNS/TLS, persistence, Cloud Firewall |
| [`deploy.md`](deploy.md) | Operator deploy runbook, health checks, rollback, and production gotchas |
| [`versioning.md`](versioning.md) | Public source, server deploy, mobile app, browser-extension, and Zapstore version streams |
| [`reliability-2026-06.md`](reliability-2026-06.md) | The June 2026 reliability program: all seven work waves, the publish/sync/archive hardening, the incident log, and remaining work |
| [`media-archive-format.md`](media-archive-format.md) | Encrypted archive blob wire formats: v1 whole-file and v2 chunked (`DMCHNK01`) with bounded-memory streaming reads |
| [`relay-policy.md`](relay-policy.md) | Server-mediated publish model, relay-allowed-pubkey writePolicy, server-side fan-out worker, watched-contact ingest, onboarding scan, lifetime-archive backfill |
| [`event-kinds.md`](event-kinds.md) | Field-by-field shape of the Nostr kinds Deepmarks uses for bookmarks and friends (kind:39701 / 10003 / 30000 / 30003 / 30001) |
| [`friends-and-lists.md`](friends-and-lists.md) | NIP-02 follows, NIP-51 friends subset, and single-author public collection model |
| [`social-bookmark-imports.md`](social-bookmark-imports.md) | Server-side import of Amethyst/Primal/Damus NIP-51 social bookmarks and referenced kind:1 posts |
| [`push-notifications.md`](push-notifications.md) | Web Push architecture, VAPID setup, vendor mapping (FCM / Mozilla Autopush / APNs), privacy boundaries, iOS Capacitor gap |
| [`bookmarks.md`](bookmarks.md) | Public/private bookmark model, personal library, edit/delete, visibility changes |
| [`read-later.md`](read-later.md) | `toread` tag convention, section tab, default toggle, sync |
| [`durable-publish.md`](durable-publish.md) | localStorage retry queue, drain triggers, re-sync recovery flow |
| [`search.md`](search.md) | Personal search default, global search toggle, query modifiers, freshness model |
| [`import-export.md`](import-export.md) | Import formats, review flow, accurate progress, immediate bookmark visibility, export |
| [`archives.md`](archives.md) | Lifetime archive UX, worker flow, Blossom fanout, archive-keys chunking, per-page and zip downloads, cross-user refcounts |
| [`archive-sync-2026-06-03.md`](archive-sync-2026-06-03.md) | June 3, 2026 production note for sync/archive-icon failures, archive worker recovery, Box A storage, object buckets, and native resubmission impact |
| [`blossom.md`](blossom.md) | Blossom archive-storage access model, archive-worker-only writes, deployment gates |
| [`backup-restore.md`](backup-restore.md) | Redis + strfry backup automation, non-destructive restore testing, archive blob sampling, disaster restore runbook |
| [`add-ons.md`](add-ons.md) | Paid extras layered on top of lifetime — hosted-checkout media archives for video/audio, always private, and the framework for adding more |
| [`zaps.md`](zaps.md) | Bookmark zap recipient selection, NWC/invoice paths, receipt ownership |
| [`settings.md`](settings.md) | Account/recovery settings, NWC, relays, Blossom backups, lifetime/API controls |
| [`extensions.md`](extensions.md) | Chrome/Firefox/Safari extension behavior, signer mode, NWC/WebLN, package layout |
| [`mobile.md`](mobile.md) | Mobile app account/bookmark behavior, app-store payment constraints, signer goal |
| [`android-foreground-signer.md`](android-foreground-signer.md) | Android foreground NIP-46 signer service behavior, implementation notes, and remaining release checks |
| [`release.md`](release.md) | Public mirror, GPL, Android/iOS, and Zapstore release checklist |
| [`zapstore.md`](zapstore.md) | Android APK build and Zapstore publish checklist |
| [`lightning.md`](lightning.md) | Voltage, BTCPay, bookmark zaps, lifetime tier, multi-LN addresses |
| [`nostr.md`](nostr.md) | Every event kind we touch, NIP compliance, identities, bunker-backed signing, citizenship rules |
| [`login.md`](login.md) | Sign-in paths (passkey / extension / remote signer / recovery key), WebAuthn + PRF + ciphertext storage, threat model |
| [`bunker.md`](bunker.md) | NIP-46 signing service on Box C — permission allowlist, wire protocol, rotation |
| [`admin.md`](admin.md) | Admin auth (NIP-98), CLI, recovery playbooks, threat model |
| [`api-v1.md`](api-v1.md) | Public REST API for lifetime-tier members |
| [`releases/v0.6.0.md`](releases/v0.6.0.md) | Public release notes for v0.6.0 |
| [`releases/v0.6.1.md`](releases/v0.6.1.md) | Public release notes for v0.6.1 |
| [`releases/v0.6.2.md`](releases/v0.6.2.md) | Public release notes for v0.6.2 |
| [`releases/v0.6.3.md`](releases/v0.6.3.md) | Public release notes for v0.6.3 |
| [`releases/v0.6.4.md`](releases/v0.6.4.md) | Public release notes for v0.6.4 |
| [`releases/v0.6.5.md`](releases/v0.6.5.md) | Public release notes for v0.6.5 |
| [`releases/v2.0.1.md`](releases/v2.0.1.md) | Historical client-aligned release notes for v2.0.1 |
| [`releases/v2.0.2.md`](releases/v2.0.2.md) | Historical client-aligned release notes for v2.0.2 |
| [`releases/v2.0.4.md`](releases/v2.0.4.md) | Historical client-aligned release notes for v2.0.4 |
| [`releases/extension-v1.3.1.md`](releases/extension-v1.3.1.md) | Historical browser-extension release notes for extension-v1.3.1 |
| [`releases/android-1.2.md`](releases/android-1.2.md) | Android 1.2 release notes |
| [`releases/android-1.3.md`](releases/android-1.3.md) | Android 1.3 release notes |
| [`releases/android-1.4.md`](releases/android-1.4.md) | Android 1.4 release notes |
| [`releases/android-1.5.md`](releases/android-1.5.md) | Android 1.5 release notes |
| [`releases/android-1.6.md`](releases/android-1.6.md) | Android 1.6 release notes |
| [`releases/android-1.7.md`](releases/android-1.7.md) | Android 1.7 release notes |
| [`releases/android-1.8.md`](releases/android-1.8.md) | Android 1.8 release notes |
| [`releases/android-1.9.md`](releases/android-1.9.md) | Android 1.9 release notes |
| [`releases/android-1.10.md`](releases/android-1.10.md) | Android 1.10 release notes |
| [`releases/android-2.0.1.md`](releases/android-2.0.1.md) | Android 2.0.1 release notes |
| [`releases/android-2.0.2.md`](releases/android-2.0.2.md) | Android 2.0.2 release notes |
| [`releases/android-2.0.3.md`](releases/android-2.0.3.md) | Android 2.0.3 release notes |
| [`releases/android-2.0.4.md`](releases/android-2.0.4.md) | Android 2.0.4 release notes |
| [`releases/android-2.0.6.md`](releases/android-2.0.6.md) | Android 2.0.6 release notes |
| [`releases/android-2.0.7.md`](releases/android-2.0.7.md) | Android 2.0.7 release notes |

Top-level project [README](../README.md) covers quickstart + repo
layout. Per-component READMEs document dev-time ergonomics:

- [`frontend/README.md`](../frontend/README.md)
- [`payment-proxy/README.md`](../payment-proxy/README.md)
- [`archive-worker/README.md`](../archive-worker/README.md)
- [`bunker/README.md`](../bunker/README.md)
- [`deploy/README.md`](../deploy/README.md)
