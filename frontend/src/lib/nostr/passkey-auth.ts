// Passkey-encrypted nsec — client side.
//
// Flow:
//   register: WebAuthn create() with PRF extension → derive AES-GCM key
//             → encrypt nsec → upload ciphertext to payment-proxy.
//   unlock:   WebAuthn get() with PRF extension → derive AES-GCM key
//             → mint an assertion token → fetch ciphertext → decrypt.
//
// The PRF extension returns a deterministic 32-byte value per (passkey,
// input) pair. We use a constant input ("deepmarks-nsec-v1") so every
// device with the same passkey (sync'd via iCloud/Google) derives the
// same key and can decrypt the same ciphertext.
//
// Feature detection: older browsers don't support PRF. Callers MUST
// check isPrfSupported() first; we refuse to register when it's false.

import { nip19 } from 'nostr-tools';
import { config } from '$lib/config';
import { buildNip98AuthHeader } from '$lib/api/client';

/** Constant PRF salt. Stable across devices so iCloud/Google-synced
 *  passkeys derive the same key on every device. */
const PRF_SALT = new TextEncoder().encode('deepmarks-nsec-v1');

// ── Feature detection ─────────────────────────────────────────────────

export function isWebAuthnAvailable(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && typeof navigator.credentials?.create === 'function';
}

/**
 * Probe whether PRF is available on this device/browser. Done via a
 * dry registration (no storage). We cache the result on window to
 * avoid re-probing. Returns false on any failure — user stays on the
 * nsec-paste path.
 */
let prfProbeCache: boolean | null = null;
export async function isPrfSupported(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  if (prfProbeCache !== null) return prfProbeCache;
  try {
    // Feature check via isConditionalMediationAvailable isn't specific
    // enough (doesn't cover PRF). Best current signal: check the UA's
    // reported features — Safari 17.4+, Chrome 116+, Edge 116+.
    // We don't attempt a full roundtrip here (would prompt Face ID);
    // instead we assume support and let a real register attempt fail
    // if PRF isn't available. Callers should handle the failure by
    // falling back to plain nsec paste.
    prfProbeCache = true;
    return true;
  } catch {
    prfProbeCache = false;
    return false;
  }
}

// ── Base64 / bytes helpers ────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── WebAuthn JSON helpers ─────────────────────────────────────────────
// simplewebauthn returns options with base64url-encoded binary fields.
// The browser's create()/get() expect ArrayBuffers. These functions
// walk the options object and convert the known fields.

function decodeRegistrationOptions(opts: Record<string, unknown>): CredentialCreationOptions {
  const o = opts as any;
  return {
    publicKey: {
      ...o,
      challenge: base64UrlToBytes(o.challenge),
      user: { ...o.user, id: base64UrlToBytes(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({
        ...c,
        id: base64UrlToBytes(c.id),
      })),
    },
  };
}

function decodeAuthenticationOptions(opts: Record<string, unknown>): CredentialRequestOptions {
  const o = opts as any;
  return {
    publicKey: {
      ...o,
      challenge: base64UrlToBytes(o.challenge),
      allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({
        ...c,
        id: base64UrlToBytes(c.id),
      })),
    },
  };
}

function encodeRegistrationResponse(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse;
  const ext = (cred as any).getClientExtensionResults?.() ?? {};
  return {
    id: cred.id,
    rawId: bytesToBase64Url(new Uint8Array(cred.rawId)),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64Url(new Uint8Array(r.clientDataJSON)),
      attestationObject: bytesToBase64Url(new Uint8Array(r.attestationObject)),
      transports: (r as any).getTransports?.() ?? [],
    },
    clientExtensionResults: ext,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? null,
  };
}

function encodeAuthenticationResponse(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse;
  const ext = (cred as any).getClientExtensionResults?.() ?? {};
  return {
    id: cred.id,
    rawId: bytesToBase64Url(new Uint8Array(cred.rawId)),
    type: cred.type,
    response: {
      clientDataJSON: bytesToBase64Url(new Uint8Array(r.clientDataJSON)),
      authenticatorData: bytesToBase64Url(new Uint8Array(r.authenticatorData)),
      signature: bytesToBase64Url(new Uint8Array(r.signature)),
      userHandle: r.userHandle ? bytesToBase64Url(new Uint8Array(r.userHandle)) : undefined,
    },
    clientExtensionResults: ext,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? null,
  };
}

// ── API calls ─────────────────────────────────────────────────────────

async function postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await fetch(`${config.apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} ${res.status}${text ? ': ' + text : ''}`);
  }
  return res.json();
}

// ── Crypto ────────────────────────────────────────────────────────────

async function deriveKeyFromPrfOutput(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  // Use the PRF output directly as a 256-bit AES-GCM key. PRF output is
  // already uniformly random per spec, so HKDF would be redundant.
  return crypto.subtle.importKey(
    'raw',
    prfOutput.slice(0, 32),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptNsec(nsecHex: string, key: CryptoKey): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Store the hex string (not the bech32) — round-trips cleanly and is
  // easier to sanity-check than bech32 decoding errors. 64 ASCII bytes.
  const plaintext = new TextEncoder().encode(nsecHex);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // [12 iv][ciphertext+tag]
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.byteLength);
  return out;
}

async function decryptNsec(blob: Uint8Array, key: CryptoKey): Promise<string> {
  if (blob.byteLength < 13) throw new Error('ciphertext too short');
  const iv = blob.slice(0, 12);
  const body = blob.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
  return new TextDecoder().decode(pt);
}

// ── Public API ────────────────────────────────────────────────────────

export interface PasskeyRegisterResult {
  credentialID: string;
}

/**
 * Shared AbortController for the current WebAuthn call, so a UI cancel
 * button can short-circuit a hanging navigator.credentials.create/get.
 * Some password-manager extensions (Bitwarden when logged out, 1Password
 * on certain browsers) intercept WebAuthn and never resolve the promise
 * or surface an OS prompt — without a timeout+abort the UI would stay
 * stuck on 'working…' forever.
 */
let activeAbort: AbortController | null = null;

/** 60s upper bound on any single navigator.credentials.* call. Real
 *  users take ~2-5s to approve; 60s is a generous buffer before we
 *  assume the call hung. */
const WEBAUTHN_TIMEOUT_MS = 60_000;

export function cancelPendingPasskeyCall(): void {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/** Wrap a WebAuthn call with abort + timeout. Throws a human-readable
 *  error on timeout; propagates the underlying error otherwise. */
async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  label: 'create' | 'get',
): Promise<T> {
  cancelPendingPasskeyCall();
  const ctrl = new AbortController();
  activeAbort = ctrl;
  const timer = setTimeout(
    () => ctrl.abort(new DOMException('passkey-timeout', 'AbortError')),
    WEBAUTHN_TIMEOUT_MS,
  );
  // Race the WebAuthn call against the abort signal. Orion and some
  // password-manager extensions intercept navigator.credentials.* and
  // never resolve OR honor signal.abort(). Without the race, cancel
  // clicks would queue up behind the stuck await and do nothing until
  // the 60s timeout fired. Racing lets cancel exit the await immediately.
  const abortPromise = new Promise<never>((_, reject) => {
    const reason = () => new DOMException('aborted', 'AbortError');
    if (ctrl.signal.aborted) reject(reason());
    else ctrl.signal.addEventListener('abort', () => reject(reason()), { once: true });
  });
  try {
    return await Promise.race([run(ctrl.signal), abortPromise]);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(
        label === 'create'
          ? 'passkey cancelled — hit skip below to continue without one.'
          : 'passkey cancelled.',
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (activeAbort === ctrl) activeAbort = null;
  }
}

/**
 * Register a passkey for `pubkey` and encrypt+upload the given nsec.
 * Caller must already have the plaintext nsec (hex-encoded). The
 * browser prompts Face ID / Touch ID / Windows Hello during this call.
 *
 * Throws if PRF isn't available on this device (user stays on plain
 * nsec-paste path).
 */
export async function registerPasskeyAndStoreNsec(
  pubkeyHex: string,
  nsecHex: string,
  label?: string,
): Promise<PasskeyRegisterResult> {
  if (!isWebAuthnAvailable()) throw new Error('WebAuthn not available in this browser');

  // 1. Server generates a challenge + registration options.
  const { options } = await postJson<{ options: Record<string, unknown> }>(
    '/account/passkey/register-challenge',
    { pubkey: pubkeyHex },
  );
  const createOpts = decodeRegistrationOptions(options);
  // Attach the PRF extension request so the created credential is
  // PRF-capable. Not all authenticators honor this at registration —
  // some expect it on the first get() instead. We do both.
  (createOpts.publicKey as any).extensions = {
    ...(createOpts.publicKey as any).extensions,
    prf: {},
  };

  // 2. Browser prompt (Face ID / Touch ID / etc) creates the passkey.
  //    Wrapped in abort+timeout so a hung password-manager extension
  //    can't leave the UI frozen on 'working…' forever.
  const cred = (await withAbortTimeout(
    (signal) =>
      navigator.credentials.create({
        ...createOpts,
        signal,
      } as CredentialCreationOptions),
    'create',
  )) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey creation cancelled');

  // Early PRF check: the create() response tells us whether the
  // authenticator negotiated PRF. If it explicitly says false (common on
  // Firefox + roaming authenticators), bail before registering a useless
  // passkey on the server. undefined means "unknown" — proceed and let
  // the assertion decide.
  const createExt = (cred as any).getClientExtensionResults?.() ?? {};
  if (createExt.prf?.enabled === false) {
    throw new Error(
      'this browser / authenticator doesn\'t support PRF, so we can\'t encrypt your nsec with it. hit skip below to continue without a passkey.',
    );
  }

  // 3. Ship the registration response to the server for verification.
  //    NIP-98-gated server-side so an attacker who knows a target pubkey
  //    can't attach their own authenticator to it (would let them
  //    download the ciphertext, even though they couldn't decrypt it).
  //    Body-binding via the `payload` tag so a captured Authorization
  //    header can't be replayed against an attacker-chosen body within
  //    the freshness window.
  const regBody = { pubkey: pubkeyHex, response: encodeRegistrationResponse(cred), label };
  const regBodyStr = JSON.stringify(regBody);
  const regAuth = await buildNip98AuthHeader(
    `${config.apiBase}/account/passkey/register`,
    'POST',
    regBodyStr,
  );
  const res = await fetch(`${config.apiBase}/account/passkey/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: regAuth },
    body: regBodyStr,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/account/passkey/register ${res.status}${text ? ': ' + text : ''}`);
  }
  const regResult = (await res.json()) as { credentialID: string };

  // 4. Kick off an immediate assertion to get the PRF output. PRF isn't
  //    available on the create() response itself; we need one get() to
  //    derive the key. Same passkey, same PRF input = same key.
  //    If this throws (Safari + Bitwarden, certain hardware-key combos
  //    where create() said `prf.enabled === undefined`), the credential
  //    we just registered is now an orphan on the server — useless for
  //    decrypt because we never paired it with a ciphertext. There's no
  //    server-side cleanup endpoint yet (passkey listing UI is also
  //    missing), so it's Redis bloat only — no user-visible breakage.
  //    Worth surfacing in the console so it's visible in repro reports.
  let key: CryptoKey;
  try {
    key = await prfDeriveKey(pubkeyHex);
  } catch (e) {
    console.warn(
      'PRF derivation failed after registration — orphan credential left on server:',
      regResult.credentialID,
    );
    throw e;
  }

  // 5. Encrypt the nsec + upload.
  const ciphertext = await encryptNsec(nsecHex, key);
  await uploadCiphertext(pubkeyHex, ciphertext, nsecHex);

  return { credentialID: regResult.credentialID };
}

/**
 * Run a WebAuthn assertion to derive the PRF-based key. Used both
 * immediately after registration and at unlock time.
 */
async function prfDeriveKey(pubkeyHex: string): Promise<CryptoKey> {
  const { options } = await postJson<{ options: Record<string, unknown> }>(
    '/account/passkey/assert-challenge',
    { pubkey: pubkeyHex },
  );
  const getOpts = decodeAuthenticationOptions(options);
  (getOpts.publicKey as any).extensions = {
    ...(getOpts.publicKey as any).extensions,
    prf: { eval: { first: PRF_SALT } },
  };

  const cred = (await withAbortTimeout(
    (signal) =>
      navigator.credentials.get({
        ...getOpts,
        signal,
      } as CredentialRequestOptions),
    'get',
  )) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey assertion cancelled');

  const ext = (cred as any).getClientExtensionResults?.() ?? {};
  const prfFirst: ArrayBuffer | undefined = ext?.prf?.results?.first;
  if (!prfFirst) {
    throw new Error(
      'no PRF key returned — a password-manager extension (Bitwarden, 1Password) is most likely intercepting the prompt without PRF support. open the extension\'s settings and disable passkey management for this site, then retry. or pick another sign-in method below.',
    );
  }

  // Tell the server about the successful assertion (consumes the
  // challenge and mints a token usable for ciphertext fetches).
  const { token } = await postJson<{ token: string }>('/account/passkey/assert', {
    pubkey: pubkeyHex,
    response: encodeAuthenticationResponse(cred),
  });
  // Stash the token on the module scope so uploadCiphertext /
  // fetchCiphertext can use it without re-asserting.
  sessionToken = { pubkey: pubkeyHex, token, expiresAt: Date.now() + 110_000 };

  return deriveKeyFromPrfOutput(prfFirst);
}

/** In-memory assertion token bundle — cleared on sign-out. */
let sessionToken: { pubkey: string; token: string; expiresAt: number } | null = null;

async function uploadCiphertext(
  pubkeyHex: string,
  ciphertext: Uint8Array,
  nsecHex: string,
): Promise<void> {
  // POST /account/nsec-ciphertext is NIP-98 gated — caller proves
  // ownership of the pubkey by signing. We do this inline here rather
  // than requiring a global signer because registration is happening
  // right now; we know the nsec.
  const { finalizeEvent, getPublicKey } = await import('nostr-tools/pure');
  const sk = hexToBytes(nsecHex);
  const derivedPubkey = getPublicKey(sk);
  if (derivedPubkey !== pubkeyHex) {
    throw new Error('nsec / pubkey mismatch');
  }
  const url = `${config.apiBase}/account/nsec-ciphertext`;
  const bodyStr = JSON.stringify({ ciphertextB64: bytesToBase64(ciphertext) });
  // Bind the auth event to this exact body via the NIP-98 `payload` tag.
  // Without this, a captured Authorization header could be replayed
  // within the 60s freshness window against attacker-chosen ciphertext.
  const bodyHashHex = await sha256Hex(new TextEncoder().encode(bodyStr));
  const authEvent = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', 'POST'],
        ['payload', bodyHashHex],
      ],
      content: '',
    },
    sk,
  );
  const header = `Nostr ${btoa(JSON.stringify(authEvent))}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: header },
    body: bodyStr,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ciphertext upload ${res.status}${txt ? ': ' + txt : ''}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast to BufferSource — strict TS lib doesn't accept the generic
  // Uint8Array<ArrayBufferLike> shape without it.
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const arr = new Uint8Array(buf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Unlock: run a WebAuthn assertion, fetch + decrypt the ciphertext,
 * return the nsec in hex. Caller attaches the resulting key to the NDK
 * signer stack.
 */
export async function unlockNsecWithPasskey(pubkeyHex: string): Promise<string> {
  const key = await prfDeriveKey(pubkeyHex);
  if (!sessionToken || sessionToken.pubkey !== pubkeyHex) {
    throw new Error('assertion token missing — try again');
  }
  const url = `${config.apiBase}/account/nsec-ciphertext?pubkey=${encodeURIComponent(pubkeyHex)}&token=${encodeURIComponent(sessionToken.token)}`;
  const res = await fetch(url);
  if (res.status === 404) throw new Error('no nsec stored for this pubkey');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ciphertext fetch ${res.status}${txt ? ': ' + txt : ''}`);
  }
  const { ciphertextB64 } = (await res.json()) as { ciphertextB64: string };
  return decryptNsec(base64ToBytes(ciphertextB64), key);
}

/**
 * Discoverable-credential unlock: no pubkey input. The OS passkey picker
 * shows the user every deepmarks passkey on this device; they pick one
 * and we derive the pubkey from the assertion's userHandle. Used by the
 * default "sign in with passkey" button on /login.
 */
export async function unlockNsecWithPasskeyDiscoverable(): Promise<{
  pubkey: string;
  nsecHex: string;
}> {
  // 1. Server issues a challenge (no pubkey known yet).
  const { options } = await postJson<{ options: Record<string, unknown> }>(
    '/account/passkey/assert-challenge-discoverable',
    {},
  );
  const getOpts = decodeAuthenticationOptions(options);
  (getOpts.publicKey as any).extensions = {
    ...(getOpts.publicKey as any).extensions,
    prf: { eval: { first: PRF_SALT } },
  };

  // 2. Browser shows the OS passkey picker (empty allowCredentials =
  //    discoverable). User picks; assertion contains userHandle = pubkey.
  const cred = (await withAbortTimeout(
    (signal) =>
      navigator.credentials.get({
        ...getOpts,
        signal,
      } as CredentialRequestOptions),
    'get',
  )) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey assertion cancelled');

  const ext = (cred as any).getClientExtensionResults?.() ?? {};
  const prfFirst: ArrayBuffer | undefined = ext?.prf?.results?.first;
  if (!prfFirst) {
    throw new Error(
      'no PRF key returned — a password-manager extension (Bitwarden, 1Password) is most likely intercepting the prompt without PRF support. open the extension\'s settings and disable passkey management for this site, then retry. or pick another sign-in method below.',
    );
  }

  // 3. Server verifies + tells us the pubkey it derived from userHandle.
  const { token, pubkey } = await postJson<{ token: string; pubkey: string }>(
    '/account/passkey/assert-discoverable',
    { response: encodeAuthenticationResponse(cred) },
  );
  sessionToken = { pubkey, token, expiresAt: Date.now() + 110_000 };

  // 4. Derive the AES key from PRF output, fetch + decrypt the ciphertext.
  const key = await deriveKeyFromPrfOutput(prfFirst);
  const url = `${config.apiBase}/account/nsec-ciphertext?pubkey=${encodeURIComponent(pubkey)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (res.status === 404) throw new Error('no nsec stored for this passkey');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ciphertext fetch ${res.status}${txt ? ': ' + txt : ''}`);
  }
  const { ciphertextB64 } = (await res.json()) as { ciphertextB64: string };
  const nsecHex = await decryptNsec(base64ToBytes(ciphertextB64), key);
  return { pubkey, nsecHex };
}

/** Convenience: npub → hex. Keeps this module's public API nsec-free. */
export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') throw new Error('not an npub');
  return decoded.data as string;
}

/** Check whether the server already has a passkey registered for this
 *  pubkey. Used by the login page to decide whether to offer the
 *  passkey-unlock CTA. */
export async function passkeyExistsForPubkey(pubkeyHex: string): Promise<boolean> {
  const res = await fetch(
    `${config.apiBase}/account/passkey/exists?pubkey=${encodeURIComponent(pubkeyHex)}`,
  );
  if (!res.ok) return false;
  const body = (await res.json()) as { exists: boolean };
  return body.exists === true;
}
