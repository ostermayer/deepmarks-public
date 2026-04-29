# Login & private key management

How users sign into Deepmarks, where their nsec lives, and how passkey
encryption fits in.

Code:
- Backend: [`payment-proxy/src/passkey.ts`](../payment-proxy/src/passkey.ts),
  [`payment-proxy/src/ciphertext.ts`](../payment-proxy/src/ciphertext.ts),
  [`payment-proxy/src/index.ts`](../payment-proxy/src/index.ts) (routes under
  `/account/passkey/*`, `/account/nsec-ciphertext`)
- Frontend: [`frontend/src/lib/nostr/passkey-auth.ts`](../frontend/src/lib/nostr/passkey-auth.ts),
  [`frontend/src/lib/stores/session.ts`](../frontend/src/lib/stores/session.ts),
  [`frontend/src/lib/nostr/signers/`](../frontend/src/lib/nostr/signers/),
  [`frontend/src/routes/signup/+page.svelte`](../frontend/src/routes/signup/+page.svelte),
  [`frontend/src/routes/login/+page.svelte`](../frontend/src/routes/login/+page.svelte),
  [`frontend/src/lib/components/PrivateKeySection.svelte`](../frontend/src/lib/components/PrivateKeySection.svelte)

## Four sign-in paths

| Path | nsec location | UX | Cross-device | Notes |
|---|---|---|---|---|
| **Passkey** | AES-GCM ciphertext in our Linode `ciphertext` bucket + local IndexedDB | Passkey (any platform authenticator — biometric or PIN) | Yes, within iCloud / Google ecosystem (passkey sync handles it) | Default for new signups; offered when pasting an nsec. Requires WebAuthn PRF support. |
| **Browser extension (NIP-07)** | In the extension. The first-party Deepmarks extension (`browser-extension/`) is the recommended path; any NIP-07 provider (Alby, nos2x, Flamingo) also works. | One click per session; extension re-auth is silent | Extension-specific (Alby syncs across browsers; Deepmarks's own ext stores in `chrome.storage.local`) | Strongest isolation for daily use; nsec never touches our page. The Deepmarks extension also bundles archive-key wrap, NIP-51 sync, NWC, and edit/delete UI. |
| **Remote bunker (NIP-46)** | On the bunker (Amber, nsec.app, self-hosted nsecBunker) | Approve each sign on the bunker | Yes — same bunker URL works on every device | Adds network round-trip per sign. Powerful permission scoping. |
| **Paste nsec (plain)** | In-browser JS memory, tab lifetime | Re-paste on every reload | No — each device re-pastes | Fallback for browsers without passkey support. |

Email signup is gone. The old magic-link / email-linked flow was removed
when passkey storage shipped — `createEmailSender` in `email.ts` now
only handles operator abuse-notification alerts.

## Passkey architecture

The passkey flow replaces "type an nsec on every reload" with "tap Face
ID." It works by encrypting the nsec with a key that only exists inside
the user's passkey, storing the ciphertext on our server, and
decrypting in-browser after a successful WebAuthn assertion.

### Key derivation (WebAuthn PRF extension)

A passkey registered with the PRF extension can produce a deterministic
pseudorandom 32-byte value given a salt input. Same passkey + same salt
always produces the same output on any device the passkey is synced to.

We use a constant salt:

```ts
const PRF_SALT = new TextEncoder().encode('deepmarks-nsec-v1');
```

The 32 output bytes become the AES-GCM-256 key. No HKDF — PRF output is
already uniformly random per spec.

### Encryption format

```
  ciphertext = IV (12 bytes) || AES-GCM-256(key, nsec_hex_utf8) (+16 byte auth tag)
```

The nsec is stored as its 64-char hex string (not bech32) so we can
sanity-check decoding round-trips without bech32 parsing concerns. The
ciphertext is max 4 KB — a generous cap for `12 + 64 + 16` bytes so
future metadata changes don't require a schema migration.

### Where each piece lives

| Artifact | Location | Access |
|---|---|---|
| Passkey private key | Inside the user's authenticator (iCloud Keychain / Google Password Manager / Windows Hello / YubiKey) | Never leaves the device; gated on biometric/PIN |
| Passkey public key + credential ID | Redis on Box A (`dm:passkey:cred:<id>`) | Payment-proxy reads at assertion time |
| `pubkey → credential IDs` set | Redis (`dm:passkey:bypubkey:<pubkey>`) | Assertion challenge narrows to this user's credentials |
| PRF-derived AES-GCM key | Browser memory, tab lifetime only | Never transmitted, never persisted |
| Nsec ciphertext | Linode Object Storage bucket `ciphertext`, key `nsec/<hex-pubkey>` | Fetch gated on fresh WebAuthn assertion token |
| Plaintext nsec (at runtime) | Browser memory of the active tab | Cleared on logout / tab close |

### Registration flow

```
  client                       payment-proxy                WebAuthn / OS
  ------                       -------------                -------------
  POST /passkey/register-challenge →
                               generate challenge, store under pubkey (180s TTL)
                          ← options (challenge, rp, user, PRF extension hint)

  navigator.credentials.create({...options, extensions: {prf: {}}}) ────→
                                                            user taps Face ID
                                                          ← credential (pubkey,
                                                              attestation)

  POST /passkey/register →
                               verify attestation via @simplewebauthn/server
                               store credential record in Redis
                               consume challenge
                          ← {credentialID}

  # PRF isn't available on the create() response — run an immediate
  # assertion to get it, then encrypt + upload the nsec.
  POST /passkey/assert-challenge → …
  navigator.credentials.get({..., prf: {eval: {first: PRF_SALT}}})
  POST /passkey/assert → {token, expiresInSeconds: 120}

  key = deriveKeyFromPrfOutput(prfResult.first)
  ciphertext = AES-GCM-encrypt(key, nsecHex)
  POST /account/nsec-ciphertext  (NIP-98 signed by the nsec owner)
    body: {ciphertextB64}
                               PUT to Object Storage at nsec/<pubkey>
```

### Unlock flow (existing user, possibly new device)

```
  client                       payment-proxy                WebAuthn / OS
  ------                       -------------                -------------
  POST /passkey/assert-challenge {pubkey} →
                               read allowCredentials from Redis,
                               generate challenge (180s TTL)
                          ← options
  navigator.credentials.get({...options, prf: {eval: {first: PRF_SALT}}})
                                                            user taps Face ID
                                                          ← assertion + PRF output

  POST /passkey/assert → verify signature + challenge,
                         bump counter (replay defense),
                         mint assertion token (120s TTL)
                  ← {token}

  GET /account/nsec-ciphertext?pubkey=<hex>&token=<token> →
                         redeem token (single-use)
                         fetch from Object Storage
                  ← {ciphertextB64}

  key = deriveKeyFromPrfOutput(prfResult.first)
  nsec = AES-GCM-decrypt(key, ciphertext)
  attach NDKPrivateKeySigner(nsec) to the NDK pool
```

### Cross-device story

Passkeys sync through the OS's credential manager:
- **iCloud Keychain** → all logged-in Apple devices (iPhone, iPad, Mac) get the passkey.
- **Google Password Manager** → Android + Chrome sessions on the same account.
- **Windows Hello** + **hardware keys** are device-bound; no sync.

Because PRF output is a function of `(passkey, salt)` and the salt is
constant, any device that has the synced passkey derives the same
AES-GCM key. The ciphertext in Object Storage is shared across devices
(indexed by pubkey), so the unlock path works anywhere.

**Cross-ecosystem (iOS ↔ Android, etc.)**: passkeys don't sync
automatically. The user re-pastes the nsec once on the new ecosystem to
register a new local passkey, or uses an extension / bunker instead.

## Endpoints reference

All live at `https://api.deepmarks.org`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/account/passkey/register-challenge` | — | Body `{pubkey}` → `{options}`. 180s server-side challenge. |
| POST | `/account/passkey/register` | NIP-98 | Body `{pubkey, response, label?}` → `{credentialID}`. Verifies attestation, stores cred record. NIP-98-gated: registration requires nsec possession so a leaked challenge can't be redeemed by anyone but the rightful pubkey. |
| POST | `/account/passkey/assert-challenge` | — | Body `{pubkey}` → `{options}` narrowed to this user's credentials. |
| POST | `/account/passkey/assert` | — | Body `{pubkey, response}` → `{token, expiresInSeconds}`. Mints a 120s single-use token. |
| GET | `/account/passkey/exists?pubkey=<hex>` | — | `{exists: bool}` — lets the login UI decide whether to offer the passkey CTA. |
| POST | `/account/nsec-ciphertext` | NIP-98 | Body `{ciphertextB64}` → `{ok}`. 4 KB cap. |
| GET | `/account/nsec-ciphertext?pubkey=<hex>&token=<token>` | Assertion token | → `{ciphertextB64}`. Token is redeemed (single-use). |
| DELETE | `/account/nsec-ciphertext` | NIP-98 | Also wipes all passkey credentials for this pubkey. |
| DELETE | `/account` | NIP-98 | Full tombstone — username release + API-key revoke + private-mark wipe + account delete + passkey wipe + ciphertext wipe. Lifetime-payment record deliberately preserved. |

The `token` intermediates the WebAuthn assertion and the ciphertext
GET. Without it, anyone could enumerate which pubkeys have ciphertext
stored with us (a mild privacy leak). With it, only the user who just
completed a fresh assertion can read their own blob. Assertion token ≠
session token; the latter (`issueSessionToken` in `auth.ts`) is still
used for API key management and unrelated here.

## Feature detection

WebAuthn PRF extension support as of April 2026:

| Browser | PRF | Notes |
|---|---|---|
| Safari 17.4+ (iOS 17.4+, macOS 14.4+) | ✅ | |
| Chrome 116+ | ✅ | |
| Edge 116+ | ✅ | |
| Firefox | ⚠️ experimental / partial | Treated as unsupported by default |
| Older Safari / Chrome | ❌ | Falls back to plain nsec paste |

Frontend probes via `isPrfSupported()` in
[`passkey-auth.ts`](../frontend/src/lib/nostr/passkey-auth.ts); the
signup / login UIs hide passkey options when unsupported and just use
the nsec paste / extension paths.

## Threat model

| Scenario | Attacker capability | Recovery |
|---|---|---|
| Our Object Storage bucket leaks | Ciphertext blobs — useless without the passkey PRF output. | None required. |
| Redis compromise (passkey credential table) | Public keys only. Can't forge assertions without the matching private key inside someone's authenticator. | None required. |
| Full Box A compromise | Attacker has both buckets' access keys + Redis. Still yields ciphertext the attacker can't decrypt. **Plus** they can sign arbitrary requests as the deepmarks origin — so active sessions' passkey unlocks could be observed during the compromise window. Rotate passkeys + re-register, and rotate S3 keys. | Rotate LINODE_ACCESS_KEY / LINODE_SECRET_KEY. Issue a "sign in again" banner to active users; new passkey registrations are fine. |
| XSS on deepmarks.org | An attacker landing JS on our origin can trick a user into approving a passkey assertion and then read the decrypted nsec from the tab's memory. Same surface as any in-browser signer (including raw nsec paste). Bunker sessions are immune here — XSS can sign during the session but can't exfiltrate the nsec itself. | Content Security Policy + dependency review. No cryptographic mitigation available while the nsec lives in browser memory. |
| User's device loss, passkey synced | New device with the synced passkey still unlocks normally. | None. |
| User's device loss, no passkey sync | Device-bound passkeys (Windows Hello, hardware keys) are gone. If the user has another registered device, that one still works. If it was the only device, the cached ciphertext is unrecoverable; user imports the nsec from their external backup. | User re-imports nsec. |
| User forgets the nsec + loses passkeys | No recovery. Nostr has no password reset. | Account gone. We cannot help by design. |
| Passkey-credential forgery | Requires breaking WebAuthn (ECDSA over the authenticator's secure element). Out of scope for this threat model. | — |

**The nsec still wins:** if a user keeps an independent backup of their
nsec somewhere (password manager note, paper, Bitcoin hardware wallet
seed-plate, etc.), they're always recoverable — they can paste it into
deepmarks or any other Nostr client. Passkey is a convenience layer,
not a custody layer. This is communicated in-product on signup and in
the Settings "reveal my nsec" copy.

## Management + lifecycle

### Adding a passkey to an existing account

Settings → "your private key" → "add passkey on this device." Only
appears when the user signed in with raw nsec paste (so the hex is in
memory) and they don't already have a passkey registered for that
pubkey. One tap Face ID + ciphertext upload.

### Revealing the nsec

Settings → "your private key" → "reveal my nsec." Shows the bech32 for
60 seconds, then auto-hides. Only available when the nsec is in memory
on this tab (paste session or passkey-unlocked session). Extension and
bunker sessions get a polite explainer pointing back to the original
signer for the raw nsec.

### Deleting

`DELETE /account` (NIP-98 authed) wipes server-side state: all passkey
credentials for the pubkey, the ciphertext blob, the username claim,
any API keys, private-mark ciphertexts, and the AccountStore record.
The user's lifetime-payment marker (if any) is preserved — the pubkey
can sign back in with the raw nsec and recover the paid tier without
re-paying.

`DELETE /account/nsec-ciphertext` is the narrower version: wipes
passkeys + ciphertext but keeps the rest of the account. Useful for
"revoke Face ID access on all my devices" without tombstoning the
whole account.

### Rotation

- **User passkey rotation**: there's no explicit rotate; the user
  registers a new passkey (settings → add passkey) then drops the old
  one via `DELETE /account/nsec-ciphertext`. For finer control, a future
  UI could list registered credential IDs and let the user remove
  individual passkeys.
- **PRF salt rotation**: if we ever need to rotate `PRF_SALT`, we'd
  re-key in-place on the next successful unlock: derive the old key,
  decrypt, re-encrypt with a new key derived from a new salt, upload
  the new ciphertext. Transparent to users. Not anticipated.
- **Object Storage access key rotation**: same process as the favicon
  bucket — update Linode Cloud Manager, swap `LINODE_ACCESS_KEY` /
  `LINODE_SECRET_KEY` in Box A's `.env`, redeploy.

## Configuration

Payment-proxy env vars (see
[`deploy/box-a/.env.example`](../deploy/box-a/.env.example)):

```
LINODE_CIPHERTEXT_BUCKET=ciphertext
LINODE_ACCESS_KEY=…
LINODE_SECRET_KEY=…
S3_ENDPOINT=https://us-southeast-1.linodeobjects.com
S3_REGION=us-southeast-1

PASSKEY_RP_ID=deepmarks.org
PASSKEY_RP_NAME=Deepmarks
PASSKEY_ORIGIN=https://deepmarks.org
```

`PASSKEY_RP_ID` **must** match the origin the frontend is served from
(minus the scheme/port). Mismatches manifest as
`navigator.credentials.create` silently rejecting. Staging deployments
need their own matching values.

Bucket-scoped access keys (Linode's "limited access keys") are
strictly better than the account-wide keys we currently share with the
favicon bucket. Worth migrating once the feature has soaked — see
[`scripts/publish-public.sh`](../scripts/publish-public.sh) comment
block for the Linode UI steps when that's done.

## Related docs

- [`architecture.md`](architecture.md) — where payment-proxy runs, VPC topology, Object Storage layout
- [`nostr.md`](nostr.md) — all Nostr event kinds we touch, including NIP-98 auth
- [`bunker.md`](bunker.md) — our own NIP-46 bunker for brand + personal identities (not user nsecs)
- [`admin.md`](admin.md) — admin auth + CLI; the `/account` endpoints reuse the same NIP-98 pattern
