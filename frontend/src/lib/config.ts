// All public config in one place; avoid scattered environment reads.
// Defaults match production endpoints; override via .env (VITE_ prefix).

const env = import.meta.env;

// ── Lifetime-tier auto-escalation ──────────────────────────────────────
// Every full year since launch adds LIFETIME_STEP_SATS to the base. The
// client-side computation here drives the UI; the api runs the
// same math server-side when it mints the actual invoice so no one can
// game the clock.
const LIFETIME_LAUNCH_DATE = new Date('2026-05-01T00:00:00Z');
const LIFETIME_BASE_SATS = 21000;
const LIFETIME_STEP_SATS = 2500;
const DEEPMARKS_LEGACY_ADMIN_SEEDER_PUBKEY =
  '7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800';
const DEEPMARKS_BRAND_SOCIAL_PUBKEY =
  '2944e915ba71cf0fc19f5dda048ce053a87c01fd7478b179330a17edca4ce2f4';

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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

const deepmarksBrandPubkey = readString('VITE_DEEPMARKS_PUBKEY', DEEPMARKS_BRAND_SOCIAL_PUBKEY);
const deepmarksSeederPubkey = readString(
  'VITE_DEEPMARKS_SEEDER_PUBKEY',
  deepmarksBrandPubkey,
);

export const config = {
  deepmarksRelay: readString('VITE_DEEPMARKS_RELAY', 'wss://relay.deepmarks.org'),
  blossomUrl: readString('VITE_BLOSSOM_URL', 'https://blossom.deepmarks.org'),
  apiBase: readString('VITE_API_BASE', 'https://api.deepmarks.org'),
  webBase: readString('VITE_WEB_BASE', 'https://deepmarks.org'),
  /** Deepmarks LNURL address. Its LNURL nostrPubkey is the
   *  operational receipt signer, not necessarily the public social key.
   *  Bookmark zaps route through this address only when the curator has
   *  no Lightning address. Also used for direct Deepmarks zaps and legacy
   *  receipt compatibility. Must match the `zap` entry in api's
   *  LN_IDENTITIES map. */
  deepmarksLnAddress: readString('VITE_DEEPMARKS_LN_ADDRESS', 'zap@deepmarks.org'),
  /** Public brand/social pubkey used for the Deepmarks Nostr presence
   *  (profile, notes, replies, reposts, Damus/social activity). The
   *  fallback hex IS the production brand/social pubkey
   *  (npub199z...) — hardcoded here because the same value is non-secret
   *  and the env var override remains for forks / dev environments. */
  deepmarksPubkey: deepmarksBrandPubkey,
  /** Public brand/social pubkey that signs the once-daily Pinboard
   *  kind:39701 bookmark and its matching kind:1 social cross-post. */
  deepmarksSeederPubkey,
  /** Deepmarks-owned bookmark authors. These get editorial treatment in
   *  ranking and are hidden when a real user has saved the same URL. */
  deepmarksEditorialPubkeys: uniqueStrings([
    deepmarksSeederPubkey,
    deepmarksBrandPubkey,
    DEEPMARKS_LEGACY_ADMIN_SEEDER_PUBKEY,
  ]),
  /** Authors used by the marketing home rails. Keep this scoped to the
   *  daily public-profile Pinboard stream. */
  landingFeedPubkeys: uniqueStrings([deepmarksSeederPubkey]),
  // Default user-facing relays — populated from NIP-65 list once user signs in.
  // Server-mediated publish model: we POST signed events to /publish,
  // and the server fans out to the user's NIP-65 write relays. For READING,
  // NDK's outbox model dynamically adds relays from other curators'
  // NIP-65 lists when we query them — those connections happen
  // on-demand, not at app boot, so we don't need a static seed list
  // here. Keeping this empty silences the "Socket is not connected"
  // noise from third-party relays that the app doesn't actually
  // depend on for the signed-in user's own content.
  defaultRelays: [] as const,
  lifetimePriceSats: computeLifetimePrice(),
  /** Per-year escalation applied to `lifetimePriceSats` — exported so UI
   *  can surface "price goes up soon" context without hard-coding. */
  lifetimePriceStepSats: LIFETIME_STEP_SATS
} as const;

/** Throws when the public brand/social pubkey isn't configured. */
export function assertDeepmarksPubkey(): string {
  if (!config.deepmarksPubkey) {
    throw new Error(
      'VITE_DEEPMARKS_PUBKEY is not configured — set it in your .env to load the curated feed.'
    );
  }
  return config.deepmarksPubkey;
}

export type Config = typeof config;
