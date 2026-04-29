// All public config in one place. CLAUDE.md: never read process.env scattered.
// Defaults match production endpoints; override via .env (VITE_ prefix).

const env = import.meta.env;

// ── Lifetime-tier auto-escalation ──────────────────────────────────────
// Every full year since launch adds LIFETIME_STEP_SATS to the base. The
// client-side computation here drives the UI; the payment-proxy runs the
// same math server-side when it mints the actual invoice so no one can
// game the clock.
const LIFETIME_LAUNCH_DATE = new Date('2026-05-01T00:00:00Z');
const LIFETIME_BASE_SATS = 21000;
const LIFETIME_STEP_SATS = 2500;

function computeLifetimePrice(now: Date = new Date()): number {
  const yearsMs = 1000 * 60 * 60 * 24 * 365.25;
  const years = Math.max(
    0,
    Math.floor((now.getTime() - LIFETIME_LAUNCH_DATE.getTime()) / yearsMs)
  );
  return LIFETIME_BASE_SATS + years * LIFETIME_STEP_SATS;
}

/** Exposed so tests and backend can reuse the same escalation curve. */
export const lifetimePricing = {
  launchDate: LIFETIME_LAUNCH_DATE,
  baseSats: LIFETIME_BASE_SATS,
  stepSats: LIFETIME_STEP_SATS,
  priceAt: computeLifetimePrice,
};

function readString(key: string, fallback: string): string {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function readOptional(key: string): string | undefined {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const config = {
  deepmarksRelay: readString('VITE_DEEPMARKS_RELAY', 'wss://relay.deepmarks.org'),
  blossomUrl: readString('VITE_BLOSSOM_URL', 'https://blossom.deepmarks.org'),
  apiBase: readString('VITE_API_BASE', 'https://api.deepmarks.org'),
  /** Deepmarks tipjar Lightning address (nostrPubkey = brand). Receives
   *  the 10% site share of zap splits + any share that couldn't be
   *  routed elsewhere. Must match the `zap` entry in payment-proxy's
   *  LN_IDENTITIES map. */
  deepmarksLnAddress: readString('VITE_DEEPMARKS_LN_ADDRESS', 'zap@deepmarks.org'),
  /** Brand pubkey used to verify zap receipts (kind:9735) AND to drive
   *  the landing-page curator feed (recent + popular rails subscribe to
   *  this pubkey's kind:39701 events). The fallback hex IS the
   *  production brand pubkey — hardcoded here because the same value
   *  is non-secret and missing it breaks the home page completely
   *  ('listening to relays…' forever instead of the curated feed). The
   *  env var override remains for forks / dev environments. */
  deepmarksPubkey: readString(
    'VITE_DEEPMARKS_PUBKEY',
    '7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800',
  ),
  // Default user-facing relays — populated from NIP-65 list once user signs in.
  defaultRelays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net'
  ] as const,
  archivePriceSats: 500,
  lifetimePriceSats: computeLifetimePrice(),
  /** Per-year escalation applied to `lifetimePriceSats` — exported so UI
   *  can surface "price goes up soon" context without hard-coding. */
  lifetimePriceStepSats: LIFETIME_STEP_SATS
} as const;

/** Throws when the brand pubkey isn't configured — call before verifying receipts. */
export function assertDeepmarksPubkey(): string {
  if (!config.deepmarksPubkey) {
    throw new Error(
      'VITE_DEEPMARKS_PUBKEY is not configured — set it in your .env to verify zap receipts.'
    );
  }
  return config.deepmarksPubkey;
}

export type Config = typeof config;
