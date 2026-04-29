// WebAuthn passkey registration + assertion for the nsec-unlock flow.
//
// Each deepmarks user can register one or more passkeys bound to their
// Nostr pubkey. We store the passkey's public key + credential ID +
// counter; the private half lives inside the user's authenticator
// (iCloud Keychain / Google / Windows Hello / hardware key) and never
// leaves.
//
// On every sensitive operation we issue a one-time challenge, record it
// in Redis under the pubkey, and require the client to return a signed
// assertion. Verification uses @simplewebauthn/server.
//
// No user PII is stored here — the pubkey itself is the only identity.

import { Redis } from 'ioredis';
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';

/** Throw on any per-op error in a multi()/pipeline. ioredis resolves
 *  exec() even when individual ops fail; a silent partial-write here
 *  would leave a credential record with no SADD index entry — the
 *  user couldn't see or revoke it from settings. */
async function execOrThrow(pipeline: { exec: () => Promise<unknown> }): Promise<void> {
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!results) throw new Error('redis pipeline failed (exec returned null)');
  for (const entry of results) {
    const err = entry?.[0];
    if (err) throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Hard cap on passkeys per pubkey. 10 is more than any realistic
 *  user (laptop, phone, backup key, work-laptop, hardware key = 5)
 *  while bounding Redis bloat from a stuck UI loop or a compromised
 *  account spamming registrations. */
const MAX_PASSKEYS_PER_PUBKEY = 10;

const CRED_BY_PUBKEY = 'dm:passkey:bypubkey:'; // SET of credential IDs (b64url)
const CRED_RECORD = 'dm:passkey:cred:';        // b64url credID → JSON record
const REG_CHALLENGE = 'dm:passkey:reg:';        // pubkey → challenge (180s TTL)
const AUTH_CHALLENGE = 'dm:passkey:auth:';      // pubkey → challenge (180s TTL)
const AUTH_CHALLENGE_DISC = 'dm:passkey:auth-disc:'; // challenge → "1" (180s) for discoverable login
const CHALLENGE_TTL_SECONDS = 180;

/** Serialized credential record. Counter is updated on every successful
 *  assertion so a replayed assertion is detectable. */
export interface PasskeyRecord {
  credentialID: string;      // base64url
  credentialPublicKey: string; // base64url of COSE key bytes
  counter: number;
  transports?: string[];
  createdAt: number;
  label?: string;
}

export interface PasskeyConfig {
  /** RP ID — the domain the passkey is bound to. MUST match the origin
   *  the client is on (minus scheme / port). Defaults to deepmarks.org;
   *  override via env on dev. */
  rpId: string;
  /** Human-readable relying-party name shown in the OS passkey UI. */
  rpName: string;
  /** Full origin used during assertion verification. Must include scheme. */
  origin: string;
}

export function passkeyConfigFromEnv(): PasskeyConfig {
  const rpId = process.env.PASSKEY_RP_ID ?? 'deepmarks.org';
  const rpName = process.env.PASSKEY_RP_NAME ?? 'Deepmarks';
  const origin = process.env.PASSKEY_ORIGIN ?? 'https://deepmarks.org';
  return { rpId, rpName, origin };
}

export class PasskeyStore {
  constructor(
    private readonly redis: Redis,
    private readonly config: PasskeyConfig,
  ) {}

  // ─── Registration ───────────────────────────────────────────────────
  //
  // 1. Client calls `startRegistration(pubkey)` → server returns options.
  // 2. Browser runs navigator.credentials.create with those options +
  //    the PRF extension, user authorizes with Face ID.
  // 3. Client POSTs the resulting RegistrationResponseJSON back.
  // 4. Server verifies the attestation, saves the credential record.

  async startRegistration(pubkey: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.requireHexPubkey(pubkey);
    const existing = await this.listCredentialIds(pubkey);
    if (existing.length >= MAX_PASSKEYS_PER_PUBKEY) {
      throw new Error(
        `passkey limit reached (${MAX_PASSKEYS_PER_PUBKEY}) — remove an existing passkey before adding a new one`,
      );
    }
    // Buffer.from → Uint8Array<ArrayBuffer>, matching simplewebauthn's
    // strict lib type. Plain `new Uint8Array(…)` resolves to
    // Uint8Array<ArrayBufferLike> on newer TS lib profiles.
    const userIDBytes = Buffer.from(pubkey, 'hex');
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: userIDBytes,
      userName: shortNpub(pubkey),
      userDisplayName: shortNpub(pubkey),
      attestationType: 'none',
      // Exclude already-registered credentials so the authenticator
      // offers a fresh slot rather than overwriting.
      excludeCredentials: existing.map((id) => ({
        id,
        transports: ['internal', 'hybrid', 'usb', 'nfc', 'ble'],
      })),
      authenticatorSelection: {
        // Discoverable credential — required so login can call get() with
        // an empty allowCredentials list and let the OS picker find the
        // passkey by itself. Without this, we'd have to ask the user for
        // their npub on every sign-in to look the credential up.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'preferred',
      },
      extensions: {
        // Advertise PRF so authenticators that support it return a
        // PRF-capable credential. Actual PRF evaluation happens on the
        // get() side with caller-supplied inputs.
        // @ts-expect-error simplewebauthn types don't yet declare prf on register
        prf: {},
      },
    });
    await this.redis.set(REG_CHALLENGE + pubkey, options.challenge, 'EX', CHALLENGE_TTL_SECONDS);
    return options;
  }

  async finishRegistration(
    pubkey: string,
    response: RegistrationResponseJSON,
    label?: string,
  ): Promise<{ credentialID: string }> {
    this.requireHexPubkey(pubkey);
    const expectedChallenge = await this.redis.get(REG_CHALLENGE + pubkey);
    if (!expectedChallenge) throw new Error('no active registration challenge');

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('passkey registration failed verification');
    }
    const { credential } = verification.registrationInfo;

    const record: PasskeyRecord = {
      credentialID: credential.id,
      credentialPublicKey: bytesToBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: response.response.transports,
      createdAt: Math.floor(Date.now() / 1000),
      label,
    };
    await execOrThrow(
      this.redis
        .multi()
        .set(CRED_RECORD + credential.id, JSON.stringify(record))
        .sadd(CRED_BY_PUBKEY + pubkey, credential.id)
        .del(REG_CHALLENGE + pubkey),
    );

    return { credentialID: credential.id };
  }

  // ─── Assertion ──────────────────────────────────────────────────────
  //
  // Same shape but for proving control of an existing credential. Used
  // to gate ciphertext reads + "reveal my nsec" in settings.

  async startAuthentication(pubkey: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.requireHexPubkey(pubkey);
    const credentialIds = await this.listCredentialIds(pubkey);
    if (credentialIds.length === 0) throw new Error('no passkeys registered for this pubkey');

    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'preferred',
      allowCredentials: credentialIds.map((id) => ({
        id,
        transports: ['internal', 'hybrid', 'usb', 'nfc', 'ble'],
      })),
      extensions: {
        // Require PRF on the same salt the client used at registration.
        // Actual PRF inputs come from the client — server doesn't care
        // about the values, only that the assertion verifies.
        // @ts-expect-error simplewebauthn types don't yet declare prf on get
        prf: {},
      },
    });
    await this.redis.set(AUTH_CHALLENGE + pubkey, options.challenge, 'EX', CHALLENGE_TTL_SECONDS);
    return options;
  }

  /** Verify an assertion. Returns true iff it matches a known credential
   *  and the challenge we issued within the last 180s. Consumes the
   *  challenge (single-use) on every outcome — even failure — so a leaked
   *  challenge can't be retried within its TTL. */
  async finishAuthentication(
    pubkey: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    this.requireHexPubkey(pubkey);
    const challengeKey = AUTH_CHALLENGE + pubkey;
    // Atomic GETDEL — the challenge is consumed even on failure paths
    // below, eliminating the "180s online forgery window" the audit
    // flagged. Requires Redis 6.2+ (deepmarks ships redis:7-alpine).
    const expectedChallenge = await this.redis.getdel(challengeKey);
    if (!expectedChallenge) return false;

    const record = await this.getCredentialRecord(response.id);
    if (!record) return false;

    // Gate the credential to its owning pubkey — a passkey registered
    // by Alice can't be used to auth as Bob even if the challenge
    // somehow matched.
    const ownedIds = await this.listCredentialIds(pubkey);
    if (!ownedIds.includes(response.id)) return false;

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: record.credentialID,
          publicKey: Buffer.from(record.credentialPublicKey, 'base64url'),
          counter: record.counter,
          transports: record.transports as Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports'],
        },
      });
      if (!verification.verified) return false;

      // Bump counter (challenge already consumed via GETDEL above).
      const updated: PasskeyRecord = {
        ...record,
        counter: verification.authenticationInfo.newCounter,
      };
      await this.redis.set(CRED_RECORD + record.credentialID, JSON.stringify(updated));
      return true;
    } catch {
      return false;
    }
  }

  // ─── Discoverable-credential authentication ────────────────────────
  //
  // Lets the client call navigator.credentials.get() with an empty
  // allowCredentials list, so the OS passkey picker shows the user every
  // deepmarks passkey on their device and they pick one — no npub paste.
  // The returned assertion's userHandle field carries the pubkey we set
  // at registration, so we can identify the user from the response alone.

  async startDiscoverableAuthentication(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'preferred',
      allowCredentials: [],
      extensions: {
        // @ts-expect-error simplewebauthn types don't yet declare prf on get
        prf: {},
      },
    });
    // Challenge stored standalone — no pubkey known yet, we'll discover
    // it from the assertion's userHandle on finish.
    await this.redis.set(
      AUTH_CHALLENGE_DISC + options.challenge,
      '1',
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
    return options;
  }

  /** Verify a discoverable-credential assertion. Returns the pubkey on
   *  success — derived from response.response.userHandle, then
   *  cross-checked against the credential record. */
  async finishDiscoverableAuthentication(
    response: AuthenticationResponseJSON,
  ): Promise<{ verified: boolean; pubkey?: string }> {
    // Extract the challenge from the response so we can look it up
    // without a pubkey hint.
    let challenge: string;
    try {
      const clientData = JSON.parse(
        Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
      ) as { challenge: string };
      challenge = clientData.challenge;
    } catch {
      return { verified: false };
    }
    const challengeKey = AUTH_CHALLENGE_DISC + challenge;
    // Atomic GETDEL — challenge is consumed even on failure paths so a
    // leaked challenge can't be retried within its TTL.
    const issued = await this.redis.getdel(challengeKey);
    if (!issued) return { verified: false };

    const record = await this.getCredentialRecord(response.id);
    if (!record) return { verified: false };

    // userHandle = the user.id we set at registration = pubkey hex bytes,
    // delivered base64url-encoded. Reject anything that isn't exactly
    // 32 bytes — the regex below catches the hex form, but we want the
    // length checked at the byte level too in case a future authenticator
    // returns extra padding or whitespace that survives decode.
    const userHandle = response.response.userHandle;
    if (!userHandle) return { verified: false };
    const userBytes = Buffer.from(userHandle, 'base64url');
    if (userBytes.byteLength !== 32) return { verified: false };
    const pubkey = userBytes.toString('hex');
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return { verified: false };

    // Cross-check: the credential ID returned must belong to the pubkey
    // the userHandle claims. Prevents a credential from being rebound to
    // a different pubkey by a malicious response.
    const ownedIds = await this.listCredentialIds(pubkey);
    if (!ownedIds.includes(response.id)) return { verified: false };

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        credential: {
          id: record.credentialID,
          publicKey: Buffer.from(record.credentialPublicKey, 'base64url'),
          counter: record.counter,
          transports: record.transports as Parameters<typeof verifyAuthenticationResponse>[0]['credential']['transports'],
        },
      });
      if (!verification.verified) return { verified: false };

      const updated: PasskeyRecord = {
        ...record,
        counter: verification.authenticationInfo.newCounter,
      };
      // Challenge already burned via GETDEL above.
      await this.redis.set(CRED_RECORD + record.credentialID, JSON.stringify(updated));
      return { verified: true, pubkey };
    } catch {
      return { verified: false };
    }
  }

  // ─── Housekeeping ───────────────────────────────────────────────────

  async listCredentialIds(pubkey: string): Promise<string[]> {
    return this.redis.smembers(CRED_BY_PUBKEY + pubkey);
  }

  async getCredentialRecord(credentialId: string): Promise<PasskeyRecord | null> {
    const raw = await this.redis.get(CRED_RECORD + credentialId);
    if (!raw) return null;
    try { return JSON.parse(raw) as PasskeyRecord; }
    catch { return null; /* corrupt blob — treat as missing rather than crashing the auth path */ }
  }

  async hasPasskey(pubkey: string): Promise<boolean> {
    return (await this.redis.scard(CRED_BY_PUBKEY + pubkey)) > 0;
  }

  /** Remove a single credential + its pubkey membership. */
  async removeCredential(pubkey: string, credentialId: string): Promise<boolean> {
    const ids = await this.listCredentialIds(pubkey);
    if (!ids.includes(credentialId)) return false;
    await execOrThrow(
      this.redis
        .multi()
        .srem(CRED_BY_PUBKEY + pubkey, credentialId)
        .del(CRED_RECORD + credentialId),
    );
    return true;
  }

  /** Wipe every passkey this pubkey owns. Used at account deletion. */
  async removeAll(pubkey: string): Promise<{ removed: number }> {
    const ids = await this.listCredentialIds(pubkey);
    if (ids.length === 0) return { removed: 0 };
    const pipeline = this.redis.multi();
    for (const id of ids) pipeline.del(CRED_RECORD + id);
    pipeline.del(CRED_BY_PUBKEY + pubkey);
    pipeline.del(REG_CHALLENGE + pubkey);
    pipeline.del(AUTH_CHALLENGE + pubkey);
    await execOrThrow(pipeline);
    return { removed: ids.length };
  }

  private requireHexPubkey(pubkey: string): void {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('invalid pubkey format');
  }
}

// ─── Encoding helpers ──────────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function shortNpub(pubkey: string): string {
  // User-visible label in the OS passkey picker. The raw hex is ugly
  // but we don't have the npub encoding here (would need nostr-tools);
  // first 8 + last 8 is readable enough.
  return `deepmarks ${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}
