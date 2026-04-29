// Shared dependency container for all per-domain route modules.
//
// `bootstrap.ts` builds one `Deps` instance at startup and passes it to
// each `routes/*.ts` `register(deps)` function. Route modules destructure
// only what they need so the wiring is explicit and the container stays
// the single place that knows how the underlying stores/signers/lnd are
// constructed.

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PurchaseStore, ZapStore } from './queue.js';
import type { AccountStore, PrivateMarkStore } from './account.js';
import type { BlocklistStore } from './blocklist.js';
import type { ReportStore } from './reports.js';
import type { ApiKeyStore } from './api-keys.js';
import type { LifetimeStore } from './lifetime.js';
import type { FaviconStore } from './favicon.js';
import type { MetadataStore } from './metadata.js';
import type { UsernameStore } from './username.js';
import type { CiphertextStore } from './ciphertext.js';
import type { BlossomBlobStore } from './blossom-blob-store.js';
import type { PasskeyStore } from './passkey.js';
import type { MeilisearchClient } from './search.js';
import type { SignerSet, RemoteSigner } from './signer.js';
import type { BtcPayConfig } from './btcpay.js';
import type { Nip98Fn, RequireNip98Fn, RequireAdminFn } from './helpers/auth-gate.js';
import type { RateLimitFn, GateRateLimitFn } from './helpers/rate-gate.js';
import type { Alerter } from './alerter.js';

export interface Deps {
  app: FastifyInstance;
  redis: Redis;

  // stores
  purchases: PurchaseStore;
  zaps: ZapStore;
  accounts: AccountStore;
  privateMarks: PrivateMarkStore;
  blocklist: BlocklistStore;
  reports: ReportStore;
  apiKeys: ApiKeyStore;
  lifetimeStore: LifetimeStore;
  faviconStore: FaviconStore | null;
  metadataStore: MetadataStore;
  usernameStore: UsernameStore;
  ciphertextStore: CiphertextStore | null;
  blossomBlobStore: BlossomBlobStore | null;
  passkeyStore: PasskeyStore;

  // external integrations
  lnd: ReturnType<typeof import('./voltage.js').connectToVoltage>;
  btcPay: BtcPayConfig | null;
  meili: MeilisearchClient;
  signers: SignerSet;
  lnIdentities: Record<string, RemoteSigner>;
  relayPool: ReturnType<typeof import('./nostr.js').createRelayPool>;
  email: ReturnType<typeof import('./email.js').createEmailSender>;
  alerter: Alerter;

  // env constants (so route modules don't read process.env)
  PUBLIC_BASE_URL: string;
  LN_ADDRESS: string;
  LN_DOMAIN: string;
  LN_USERNAME: string;
  CORS_ORIGIN: string[];
  LIFETIME_LABEL_RELAYS: string[];
  INDEXER_RELAY_URL_FOR_API: string;
  ADMIN_PUBKEYS: Set<string>;

  // helpers — types come from helpers/*.ts so a future signature change
  // there compile-errors the wire-up in bootstrap.ts immediately, instead
  // of silently drifting from the Deps interface.
  nip98: Nip98Fn;
  requireNip98: RequireNip98Fn;
  requireAdmin: RequireAdminFn;
  rateLimit: RateLimitFn;
  gateRateLimit: GateRateLimitFn;
  requireSession: (
    authHeader: string | undefined,
  ) => Promise<
    | { ok: true; pubkey: string; emailHash: string; tier: 'email' | 'full' }
    | { ok: false; status: number; reason: string }
  >;
}
