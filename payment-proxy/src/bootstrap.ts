// Construct the `Deps` container shared across all route modules.
//
// Reads env vars, opens external connections (Voltage gRPC, Redis,
// Meilisearch, Linode buckets, BTCPay, signers, relay pool), constructs
// every store class, builds the per-request helper closures
// (NIP-98 verify, rate-limit, requireSession, requireAdmin), and returns
// the assembled `Deps`. Workers that run alongside the HTTP server are
// constructed and started by `index.ts` (after `app.listen`), not here.

import type { FastifyInstance } from 'fastify';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { connectToVoltage, validateVoltageConnection } from './voltage.js';
import { PurchaseStore, ZapStore, createRedis } from './queue.js';
import { btcPayConfigFromEnv, type BtcPayConfig } from './btcpay.js';
import { LifetimeStore } from './lifetime.js';
import { createRelayPool } from './nostr.js';
import { buildSigners, loadSignerConfigFromEnv, type RemoteSigner, type SignerSet } from './signer.js';
import { AccountStore, PrivateMarkStore } from './account.js';
import { MeilisearchClient } from './search.js';
import { createEmailSender } from './email.js';
import { makeAlerter } from './alerter.js';
import { issueSessionToken, verifySessionToken } from './auth.js';
import { BlocklistStore } from './blocklist.js';
import { ReportStore } from './reports.js';
import { ApiKeyStore } from './api-keys.js';
import { FaviconStore, buildFaviconS3Client, faviconConfigFromEnv } from './favicon.js';
import { MetadataStore } from './metadata.js';
import { UsernameStore } from './username.js';
import {
  CiphertextStore,
  buildCiphertextS3Client,
  ciphertextConfigFromEnv,
} from './ciphertext.js';
import {
  BlossomBlobStore,
  buildBlossomBlobS3Client,
  blossomBlobConfigFromEnv,
} from './blossom-blob-store.js';
import { PasskeyStore, passkeyConfigFromEnv } from './passkey.js';

import { makeNip98, makeRequireNip98, makeRequireAdmin } from './helpers/auth-gate.js';
import { makeRateLimit, makeGateRateLimit } from './helpers/rate-gate.js';
import type { Deps } from './route-deps.js';

// Re-exported for `index.ts` so it doesn't need a separate session-issue
// import path; rotate-pubkey lives in routes/account.ts.
export { issueSessionToken };

/** Fallback relay for /api/v1 read/write when no NIP-65 list is known. */
const INDEXER_RELAY_URL_FOR_API =
  process.env.INDEXER_RELAY_URL ?? 'ws://strfry:7777';

const LN_USERNAME = process.env.DEEPMARKS_LN_USERNAME ?? 'zap';
const LN_DOMAIN = process.env.DEEPMARKS_LN_DOMAIN ?? 'deepmarks.org';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `https://${LN_DOMAIN}`;
const LN_ADDRESS = `${LN_USERNAME}@${LN_DOMAIN}`;

// CORS_ORIGIN supports a CSV of allowed origins. fastify-cors compares
// the request Origin header literally when given a string, so passing
// "a,b" silently breaks both. Split into an array so each origin matches.
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'https://deepmarks.org')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

export function envCorsOrigin(): string[] {
  return CORS_ORIGIN;
}

export function envPublicBaseUrl(): string {
  return PUBLIC_BASE_URL;
}

/** SHA-256 of a UTF-8 string, returned as lowercase hex. */
function sha256hex(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s)));
}

export async function buildDeps(app: FastifyInstance): Promise<Deps> {
  // Open (or skip, in dev) the Voltage gRPC client. We don't trust the
  // connection until validateVoltageConnection() below says OK — that way
  // a bad endpoint fails loud at boot instead of silently retrying forever
  // and hammering the Voltage node.
  let lnd = connectToVoltage();
  if (lnd) {
    const check = await validateVoltageConnection(lnd);
    if (!check.ok) {
      app.log.error({ reason: check.reason, hint: check.hint }, 'voltage handshake failed — disabling Lightning paths');
      lnd = null;
    } else {
      app.log.info('voltage connection verified');
    }
  }

  const redis = createRedis();

  const nip98 = makeNip98(redis);
  const requireNip98 = makeRequireNip98(nip98);
  const rateLimit = makeRateLimit(redis);
  const gateRateLimit = makeGateRateLimit(rateLimit);

  const purchases = new PurchaseStore(redis);
  const zaps = new ZapStore(redis);
  const accounts = new AccountStore(redis);
  const privateMarks = new PrivateMarkStore(redis);
  const blocklist = new BlocklistStore(redis);
  const reports = new ReportStore(redis);
  const apiKeys = new ApiKeyStore(redis);
  const lifetimeStore = new LifetimeStore(redis);

  // Site-favicon cache backed by Linode Object Storage. Disabled when the
  // required S3 env vars are missing; the route still exists and returns
  // 503 so the frontend can gracefully fall back to its inline icon.
  const faviconConfig = faviconConfigFromEnv();
  const faviconStore = faviconConfig
    ? new FaviconStore(redis, buildFaviconS3Client(faviconConfig), faviconConfig, app.log)
    : null;
  if (faviconStore) {
    // Don't block boot on S3 — ensureDefaultExists logs + swallows its own
    // errors, and a missed default just means misses fall back to the
    // frontend's inline SVG instead of the server's.
    void faviconStore.ensureDefaultExists();
    app.log.info({ bucket: faviconConfig!.bucket }, 'favicon cache enabled');
  } else {
    app.log.warn('favicon cache disabled — set S3_ENDPOINT + FAVICON_BUCKET + LINODE_ACCESS_KEY + LINODE_SECRET_KEY');
  }

  const metadataStore = new MetadataStore(redis);
  const usernameStore = new UsernameStore(redis);
  const passkeyStore = new PasskeyStore(redis, passkeyConfigFromEnv());

  // Passkey-encrypted nsec storage lives on its own Linode Object Storage
  // bucket. Same access keys as the favicon bucket, just a different
  // bucket so the blast radius on a leak is one data class, not both.
  const ciphertextConfig = ciphertextConfigFromEnv();
  const ciphertextStore = ciphertextConfig
    ? new CiphertextStore(buildCiphertextS3Client(ciphertextConfig), ciphertextConfig, app.log)
    : null;
  if (ciphertextStore) {
    app.log.info({ bucket: ciphertextConfig!.bucket }, 'nsec ciphertext storage enabled');
  } else {
    app.log.warn('nsec ciphertext storage disabled — set S3_ENDPOINT + LINODE_* env vars');
  }

  // Direct S3 access to the Blossom server's blob bucket — used by the
  // user-facing "delete my archive" route. blossom-server itself stores
  // by SHA-256 hash with no separate index, so an S3 deleteObject is the
  // server-side teardown. Disabled when env is missing; the delete
  // route still exists and 503s, with the entry-list cleanup still
  // happening so the user's UI reflects the intent.
  const blossomBlobConfig = blossomBlobConfigFromEnv();
  const blossomBlobStore = blossomBlobConfig
    ? new BlossomBlobStore(buildBlossomBlobS3Client(blossomBlobConfig), blossomBlobConfig, app.log)
    : null;
  if (blossomBlobStore) {
    app.log.info({ bucket: blossomBlobConfig!.bucket }, 'blossom blob deletion enabled');
  } else {
    app.log.warn('blossom blob deletion disabled — set BLOSSOM_S3_BUCKET + LINODE_* env vars');
  }

  const btcPay: BtcPayConfig | null = btcPayConfigFromEnv();
  if (btcPay) {
    app.log.info({ url: btcPay.url, storeId: btcPay.storeId }, 'btcpay configured');
  } else {
    app.log.warn('btcpay not configured — lifetime upgrades disabled');
  }
  // Operational email sender — used for CSAM/abuse notifications and
  // the operational alerter (errors, bunker disconnects, archive
  // failures, etc.). User-facing email signup is gone; passkey-encrypted
  // nsec storage is the mainstream path.
  const email = createEmailSender();
  // Alerter sends operational warnings to the operator's inbox with
  // per-key debouncing + a global hourly ceiling so a flapping
  // dependency can't email-spam. Empty ALERT_EMAIL → no-op (dev mode).
  const alerter = makeAlerter({
    email,
    redis,
    to: process.env.ALERT_EMAIL ?? '',
    logger: {
      info: (...a: unknown[]) => app.log.info(a[0] as object, a[1] as string),
      error: (...a: unknown[]) => app.log.error(a[0] as object, a[1] as string),
    },
  });
  // Nsecs live on Box C in the bunker — never on this box. Build
  // BunkerSigner handles for each identity; they maintain a persistent
  // NIP-46 session over strfry and expose an async .sign(template) API.
  const signerEnv = loadSignerConfigFromEnv();
  const signers: SignerSet = buildSigners(signerEnv, {
    info: (obj, msg) => app.log.info(obj, msg),
    warn: (obj, msg) => app.log.warn(obj, msg),
    error: (obj, msg) => app.log.error(obj, msg),
  });
  /** Map LNURL usernames → the signer that backs that Lightning address.
   *  Every entry must advertise the signer's pubkey as `nostrPubkey` in
   *  its LNURL metadata, and sign kind:9735 receipts with the same key. */
  const lnIdentities: Record<string, RemoteSigner> = {
    zap: signers.brand,
    dan: signers.personal,
  };
  const relayPool = createRelayPool();

  // Relays for durability-layer NIP-32 lifetime labels. Internal strfry
  // is fastest and is the same store backing wss://relay.deepmarks.org;
  // fanout to public relays gives us extra redundancy so a label
  // survives even if our box / bucket is lost.
  const LIFETIME_LABEL_RELAYS = (process.env.LIFETIME_LABEL_RELAYS ?? 'ws://strfry:7777,wss://relay.damus.io,wss://nos.lol')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const meili = new MeilisearchClient(
    process.env.MEILI_URL ?? 'http://meilisearch:7700',
    process.env.MEILI_MASTER_KEY ?? '',
  );

  app.log.info(
    { lnAddress: LN_ADDRESS, brandPubkey: signers.brand.pubkey, personalPubkey: signers.personal.pubkey },
    'payment proxy initialized',
  );

  /**
   * Verify a Bearer JWT AND check it hasn't been invalidated by a
   * session_version bump on the underlying account.
   */
  async function requireSession(
    authHeader: string | undefined,
  ): Promise<
    | { ok: true; pubkey: string; emailHash: string; tier: 'email' | 'full' }
    | { ok: false; status: number; reason: string }
  > {
    const match = authHeader && /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) return { ok: false, status: 401, reason: 'no session' };
    const claims = verifySessionToken(match[1]);
    if (!claims) return { ok: false, status: 401, reason: 'invalid or expired session' };
    const account = await accounts.getByEmailHash(claims.emailHash);
    if (!account) return { ok: false, status: 401, reason: 'account not found' };
    if (account.sessionVersion > claims.sessionVersion) {
      return { ok: false, status: 401, reason: 'session invalidated (key rotation or password change)' };
    }
    return {
      ok: true,
      pubkey: account.pubkey,
      emailHash: account.emailHash,
      tier: claims.tier,
    };
  }

  // Validated, logged at boot. A typo (e.g. an npub bech32 instead of
  // hex) would otherwise silently disable admin without any error —
  // the route exists, every call returns 'not an admin', operators
  // never notice. We log the count + a redacted set so drift is
  // visible. Empty set is allowed (some envs legitimately have no
  // admin) but we warn on it.
  const ADMIN_PUBKEYS = new Set<string>();
  for (const raw of (process.env.ADMIN_PUBKEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      ADMIN_PUBKEYS.add(raw.toLowerCase());
    } else {
      app.log.warn({ entry: raw.slice(0, 12) + '…' }, 'ADMIN_PUBKEYS entry is not 64-char hex — ignored');
    }
  }
  if (ADMIN_PUBKEYS.size === 0) {
    app.log.warn('ADMIN_PUBKEYS is empty — every /admin/* route will reject ("not an admin")');
  } else {
    app.log.info(
      { count: ADMIN_PUBKEYS.size, sample: [...ADMIN_PUBKEYS].map((p) => p.slice(0, 12) + '…') },
      'admin pubkeys loaded',
    );
  }

  const requireAdmin = makeRequireAdmin({
    nip98,
    publicBaseUrl: PUBLIC_BASE_URL,
    adminPubkeys: ADMIN_PUBKEYS,
    rateLimit,
  });

  // Side-effect: `sha256hex` is used by the BookmarkIndexer (started in
  // index.ts) and elsewhere; export-shaped so the constructor sites can
  // import it from this module instead of duplicating it.
  return {
    app,
    redis,
    purchases,
    zaps,
    accounts,
    privateMarks,
    blocklist,
    reports,
    apiKeys,
    lifetimeStore,
    faviconStore,
    metadataStore,
    usernameStore,
    ciphertextStore,
    blossomBlobStore,
    passkeyStore,
    lnd,
    btcPay,
    meili,
    signers,
    lnIdentities,
    relayPool,
    email,
    alerter,
    PUBLIC_BASE_URL,
    LN_ADDRESS,
    LN_DOMAIN,
    LN_USERNAME,
    CORS_ORIGIN,
    LIFETIME_LABEL_RELAYS,
    INDEXER_RELAY_URL_FOR_API,
    ADMIN_PUBKEYS,
    nip98,
    requireNip98,
    requireAdmin,
    rateLimit,
    gateRateLimit,
    requireSession,
  };
}

export { sha256hex };
