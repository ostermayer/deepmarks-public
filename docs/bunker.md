# Bunker

Box C's NIP-46 signing service. Holds the brand (`zap@deepmarks.org`)
and personal (`dan@deepmarks.org`) nsecs and answers signing requests
from payment-proxy over a Nostr relay — so no nsec lives on Box A.

Code: [`bunker/`](../bunker/). Deploy: [`deploy/box-c/`](../deploy/box-c/).

## Why

Before Box C, `DEEPMARKS_NSEC` sat in Box A's `.env` and any
compromise of the payment-proxy host granted the attacker total
control of the brand identity on Nostr — they could post as
`@deepmarks`, delete events, change the profile, rotate keys. Moving
the nsec behind a NIP-46 bunker with a permission allowlist reduces the
blast radius of a Box A compromise to "attacker can sign a narrow set
of event kinds for a fixed window."

## Threat model

| Scenario | Attacker capability |
|---|---|
| Box A compromise | Can request signatures on the allowlist (brand ×  {9735, 1985, 39701}; personal × {9735}) using the ephemeral `BUNKER_CLIENT_NSEC`. **Cannot** exfiltrate any nsec. **Cannot** sign kind:1 notes, kind:0 profile edits, kind:5 deletions, kind:10002 relay lists, or any kind not on the allowlist. Rotation: generate a new client keypair, update Box A's `BUNKER_CLIENT_NSEC` + Box C's `BUNKER_CLIENT_PUBKEY`, redeploy both. Old client's future requests start being rejected immediately. |
| Box C compromise | Can read both nsecs from disk (chmod 400 is defense-in-depth, not a boundary against root). Full control of brand and personal on Nostr. Rotation: generate new nsecs, drop into `/opt/deepmarks-bunker/nsecs/`, update Box A's `BUNKER_BRAND_PUBKEY` / `BUNKER_PERSONAL_PUBKEY` envs. LNURL metadata will start advertising the new pubkeys; old receipts become unverifiable by NIP-57-strict clients. |
| strfry compromise | Relay operator sees only NIP-44 ciphertext on kind:24133 events. The envelope exposes timing and pubkey-pair metadata but not request contents. Since we own strfry this is moot; if it were an external relay, traffic analysis could reveal signing patterns but not payloads. |
| Bunker sign request forgery | Every request must come from the one `BUNKER_CLIENT_PUBKEY` the bunker was configured with at boot. Every outcome (accepted, rejected, errored) is audited to `/var/log/deepmarks-bunker/audit.jsonl`. |
| Operator laptop compromise | Admin `deepmarks-admin-nsec.txt` lets attacker impersonate the admin — comp lifetime memberships, view the member list, moderate. Same key, held on Box C too, means the attacker could also pretend to be the brand by uploading a manipulated nsec to a bunker they control. Recoverable by rotating the shared brand nsec. |

## Identity + permission allowlist

Hardcoded in [`bunker/src/permissions.ts`](../bunker/src/permissions.ts)
— changing what a client can sign requires a code change + review, not
an env flip.

| Identity | Pubkey | Source | Allowed kinds | Purpose |
|---|---|---|---|---|
| `brand` | `npub10jeec…` | `/opt/deepmarks-bunker/nsecs/brand.nsec` | `9735`, `1985`, `39701` | Zap receipts for `zap@deepmarks.org`, NIP-32 lifetime labels on settlement, Pinboard seeder bookmarks |
| `personal` | (operator's npub, e.g. `npub199z…`) | `/opt/deepmarks-bunker/nsecs/personal.nsec` | `9735` | Zap receipts for `dan@deepmarks.org` (personal Damus profile) |

Unauthorized client pubkeys and disallowed kinds both get audited as
`rejected`. There is **no path** to sign kind:1 (notes), kind:0
(profile), kind:5 (deletion), kind:10002 (relay list), or any kind
not on the list for its identity.

## Wire protocol

Standard [NIP-46 (nostr-connect)](https://github.com/nostr-protocol/nips/blob/master/46.md)
over Box A's strfry relay:

```
payment-proxy                              strfry (10.0.0.2:7777)                              bunker (Box C)
─────────────                              ──────────────────────                              ──────────────
  kind:24133 event
  p-tag = identity pubkey         ────────────────────────►          ─────────────────────►
  content = NIP-44(clientNsec, identity) {                                                       decrypt,
    id: <random>,                                                                                parse request,
    method: "sign_event",                                                                        permission-check,
    params: [<event template JSON>]                                                              vault.sign(identity, template),
  }                                                                                              audit log,
                                                                                                 kind:24133 event
                                                                                                 p-tag = client pubkey
                                                                                                 content = NIP-44(identity, client) {
  match by id, decrypt,           ◄────────────────────          ◄────────────────────────        id: <same>,
  return signed event                                                                             result: <signed JSON>
                                                                                                 }
```

The response event itself is signed by the identity nsec (not the
bunker's own key), so the NIP-44 encryption derives from the same
`(client_sk, identity_pk)` conversation key the request used.

## Deploy

First-time Box C setup:

```bash
# On Box C, one-time:
sudo bash /opt/deepmarks-repo/deploy/box-c/setup-system.sh
# Creates bunker:bunker (uid 900) + /opt/deepmarks-bunker/nsecs/ +
# /var/log/deepmarks-bunker/

# Place the nsec files (chmod 400, owned by bunker:bunker):
sudo install -m 400 -o bunker -g bunker /tmp/brand.nsec \
  /opt/deepmarks-bunker/nsecs/brand.nsec
sudo install -m 400 -o bunker -g bunker /tmp/personal.nsec \
  /opt/deepmarks-bunker/nsecs/personal.nsec
sudo shred -u /tmp/brand.nsec /tmp/personal.nsec

# Fill in the one required env var:
echo "BUNKER_CLIENT_PUBKEY=<payment-proxy's client pubkey>" \
  | sudo tee /opt/deepmarks-repo/deploy/box-c/.env
sudo chmod 600 /opt/deepmarks-repo/deploy/box-c/.env

# Start the service:
/opt/deepmarks-repo/deploy/deploy.sh c
```

On Box A, the matching envs are:

```
BUNKER_CLIENT_NSEC=<nsec that derives to BUNKER_CLIENT_PUBKEY>
BUNKER_RELAY_URL=ws://strfry:7777
BUNKER_BRAND_PUBKEY=<brand nsec's pubkey, hex>
BUNKER_PERSONAL_PUBKEY=<personal nsec's pubkey, hex>
```

## Observability

- **`docker logs box-c-bunker-1`** — boot messages, relay connect /
  reconnect activity.
- **`/var/log/deepmarks-bunker/audit.jsonl`** — one line per signing
  request. Fields: `ts, clientPubkey, identity, kind, outcome
  (accepted|rejected|errored), reason?, eventId?`. Rotate with
  logrotate; never truncate live.
- **Health endpoint** — inside the container only, at
  `http://localhost:4100/health`. Docker's HEALTHCHECK polls it.

## Rotation

### Rotating the brand or personal nsec

1. Generate a new nsec.
2. Replace the file on Box C:
   `sudo install -m 400 -o bunker -g bunker newnsec.txt /opt/deepmarks-bunker/nsecs/<brand|personal>.nsec`
3. Restart the bunker: `docker compose -f deploy/box-c/compose.yml restart bunker`
4. Compute the new pubkey; update `BUNKER_BRAND_PUBKEY` / `BUNKER_PERSONAL_PUBKEY` in Box A's `.env`.
5. Redeploy Box A: `/opt/deepmarks-repo/deploy/deploy.sh a`.
6. LNURL metadata now advertises the new pubkey. Old receipts become
   unverifiable by strict NIP-57 clients; new ones verify against the
   new identity.

### Rotating the bunker client keypair

Less disruptive — no user-visible pubkey change.

1. Generate a new client keypair.
2. Update Box A's `BUNKER_CLIENT_NSEC` env, redeploy A.
3. Update Box C's `BUNKER_CLIENT_PUBKEY` env, redeploy C.
4. Old client's requests start being rejected immediately after C's
   restart.

## Tests

47 tests in `bunker/src/*.test.ts`:

- `permissions.test.ts` — accepts and rejects the full identity × kind
  matrix, enforcing the allowlist including the 39701 brand-only rule.
- `vault.test.ts` — nsec file loading (bech32 + hex), pubkey derivation,
  signed-event verification, unknown-identity rejection.
- `nip46.test.ts` — NIP-44 round-trip between conversation key pairs,
  request parsing, sign-event param extraction, response encoding.
- `handler.test.ts` — full pipeline: decrypt → dispatch → permission
  check → sign → encrypt. Covers: brand signs 9735, brand signs 1985,
  brand *cannot* sign kind:1, dan *cannot* sign kind:1985, unaddressed
  events return null silently, undecryptable ciphertext gets audited as
  errored without responding, `connect` ACKs authorized clients and
  rejects unauthorized ones.
- `audit.test.ts` — append-only JSONL with correct field shapes.

## Related docs

- [nostr.md](nostr.md#how-the-server-signs-without-holding-keys) —
  protocol-level overview of the signing round-trip.
- [architecture.md](architecture.md#box-c--nsec-bunker-10004) —
  Box C's place in the overall topology.
- [admin.md](admin.md#threat-model) — key-rotation playbooks.
- [lightning.md](lightning.md#lnurl-pay--two-hosted-addresses) —
  which LN address maps to which identity.
