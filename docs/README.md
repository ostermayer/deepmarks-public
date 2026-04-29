# Deepmarks docs

Operator-facing references for running Deepmarks. Design specs + HTML
mockups remain in [`MVP/deepmarks/`](../MVP/deepmarks/) — those are the
immutable product spec.

| File | Topic |
|---|---|
| [`architecture.md`](architecture.md) | Host layout (Box A/B/C), services, data flow, DNS/TLS, persistence, Cloud Firewall |
| [`lightning.md`](lightning.md) | Voltage, BTCPay, zap splits, archive invoices, lifetime tier, multi-LN addresses |
| [`nostr.md`](nostr.md) | Every event kind we touch, NIP compliance, identities, bunker-backed signing, citizenship rules |
| [`login.md`](login.md) | Sign-in paths (passkey / extension / bunker / nsec), WebAuthn + PRF + ciphertext storage, threat model |
| [`bunker.md`](bunker.md) | NIP-46 signing service on Box C — permission allowlist, wire protocol, rotation |
| [`admin.md`](admin.md) | Admin auth (NIP-98), CLI, recovery playbooks, threat model |
| [`api-v1.md`](api-v1.md) | Public REST API for lifetime-tier members |

Top-level project [README](../README.md) covers quickstart + repo
layout. Per-component READMEs document dev-time ergonomics:

- [`frontend/README.md`](../frontend/README.md)
- [`payment-proxy/README.md`](../payment-proxy/README.md)
- [`archive-worker/README.md`](../archive-worker/README.md)
- [`bunker/README.md`](../bunker/README.md)
- [`deploy/README.md`](../deploy/README.md)
