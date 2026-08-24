# Browser extension v2.2.10

Chrome, Firefox, and Safari. Cut 2026-08-22. One theme: nsec input
handling in the popup — the extension's copy of the same bugs fixed in
the web app's nsec signer the same day (code-review findings, commit
`ffb636c` for the web side).

## Fixed

- **A typo'd nsec no longer echoes the pasted secret.** `nip19.decode`
  throws a checksum error whose message contains the full pasted
  string, and the Login/Unlock screens render error messages into the
  popup DOM — so a near-complete secret key appeared on screen. Decode
  is now guarded; every rejection is a friendly message with no input
  echo.
- **ALL-UPPERCASE bech32 nsec accepted.** bech32 permits an uppercase
  encoding (QR alphanumeric mode produces it); the case-sensitive
  prefix sniff rejected it with the generic format error. Input is now
  normalized before dispatch.
- **Curve-invalid 64-hex gets a friendly error.** All-zeros or
  ≥-curve-order hex passed the shape check and made noble throw a raw
  library error from `getPublicKey`; it now reads "That is not a valid
  secp256k1 secret key."
- **Invisible characters stripped.** Zero-width spaces/joiners and BOMs
  smuggled in by phone messengers are removed before trimming, so a
  paste that looks valid on screen decodes.

Four regression tests cover all of the above
(`tests/browser-extension/lib/nsec-store.test.ts`).

## Versions

- Chrome / Firefox manifests: 2.2.10 (zips rebuilt in their folders).
- Safari: MARKETING_VERSION 2.2.10, build counter 30; Resources synced —
  open `safari/Deepmarks/Deepmarks.xcodeproj` to build and submit.
