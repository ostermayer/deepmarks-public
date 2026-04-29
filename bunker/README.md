# bunker

Box C signing service. Holds the brand + personal nsecs behind a NIP-46
interface so the keys never live on the payment-proxy box.

## What it does

- Listens on Box A's strfry relay (`ws://strfry.vpc:7777`) for
  `kind:24133` events addressed at one of its identity pubkeys.
- Decrypts NIP-44, validates the request against a hardcoded permission
  allowlist (`permissions.ts`), signs the requested event with the
  matching identity's nsec, encrypts + publishes the signed response
  back to the relay.
- Writes every request outcome (accepted / rejected / errored) to an
  append-only JSONL audit log.
- Exposes `/health` on port 4100 for Docker's healthcheck.

## Permission model

Hardcoded per identity in `src/permissions.ts`. Changing what an
authorized client can sign requires a code change + review. Current
matrix:

| Identity | Pubkey source | Allowed kinds |
|---|---|---|
| `brand` (`zap@deepmarks.org`) | `/run/secrets/brand.nsec` | 9735 (zap receipts), 1985 (lifetime labels), 39701 (Pinboard seeder bookmarks) |
| `personal` (operator's LN address, e.g. `dan@deepmarks.org`) | `/run/secrets/personal.nsec` | 9735 |

Unauthorized client pubkeys and disallowed kinds both get audited as
`rejected`. There is no way to sign `kind:1` (notes), `kind:0`
(profile), `kind:5` (deletion), etc. through this service.

## Env

See `.env.example`. The required vars are:

- `BUNKER_RELAY_URL` — usually `ws://10.0.0.2:7777` on the VPC
- `BUNKER_BRAND_NSEC_PATH` + `BUNKER_PERSONAL_NSEC_PATH` — file paths
- `BUNKER_CLIENT_PUBKEY` — the single payment-proxy pubkey this bunker
  will honor. Rotating is a code-free ops step: update this env var and
  restart.

## Running locally

```bash
npm install
npm run test            # 47 tests
npm run typecheck
npm run dev             # tsx watch src/index.ts
```

For a local smoke test without the real strfry, point `BUNKER_RELAY_URL`
at any running Nostr relay (e.g. `wss://relay.damus.io` — fine for
testing, but the real deploy stays on the private VPC).

## Running in Docker (production)

Via `deploy/box-c/compose.yml` on Box C. Volumes mount the nsec files
read-only and the audit directory read-write. Container runs as the
`bunker` user inside the image (uid assigned at build time) which owns
nothing on the host outside its volumes.

## Security posture

- Nsecs live only on Box C, owned by `bunker` user, chmod 400.
- Box C has no public ingress beyond port 22 (UFW role `c`).
- Bunker ↔ payment-proxy traffic traverses Box A's strfry over the VPC,
  never the public internet.
- Relay sees only NIP-44 ciphertext; only holders of the private key
  pair `(client_sk, identity_pk)` can read the plaintext requests.
- A compromised Box A gets the ability to *request* signatures for the
  kinds listed above; it does NOT get the ability to exfiltrate keys or
  sign any other kind. Fake lifetime labels can be reconciled by
  `./deploy/admin.mjs reconcile` against BTCPay's ledger.

## Tests

`src/*.test.ts` — 47 tests covering:

- Permission matrix accepts/rejects every brand+personal×9735+1985+1+0+5
  combination
- NIP-44 round-trip between conversation key pairs
- Sign-event template parsing (required fields, defaults, ignored
  fields)
- Full handler pipeline: decrypt → dispatch → permission check → sign →
  encrypt for both accepted and rejected paths
- Audit log is append-only JSONL with correct field shapes
- Unaddressed events return null (no side effects, no response)
- Undecryptable ciphertext is audited as `errored` without responding
