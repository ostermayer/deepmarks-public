// Lifetime-membership store, keyed by Nostr pubkey (not email).
//
// This is THE lifetime source of truth: the payment is attached to a
// pubkey, period. (An email-keyed AccountStore used to hold a secondary
// lifetime marker; the whole email-account subsystem — the remnant of
// the magic-link login removed when passkeys shipped — was deleted on
// 2026-08-23, see docs/robustness-review-2026-08-23.md.)

import { Redis } from 'ioredis';

const LIFETIME_PREFIX = 'dm:lifetime:';
const PENDING_PREFIX = 'dm:lifetime-pending:';
const PENDING_TTL_SECONDS = 24 * 60 * 60;

// Server-side lifetime price (must match `frontend/src/lib/config.ts`'s
// computeLifetimePrice). The frontend value is informational; only this
// function gates actual invoice creation, so the buyer can't lower the
// price by passing an `amountSats` field.
const LIFETIME_LAUNCH_DATE = new Date('2026-05-01T00:00:00Z');
const LIFETIME_BASE_SATS = 21000;
const LIFETIME_STEP_SATS = 2500;

export function computeLifetimePriceSats(now: Date = new Date()): number {
  const yearsMs = 1000 * 60 * 60 * 24 * 365.25;
  const years = Math.max(
    0,
    Math.floor((now.getTime() - LIFETIME_LAUNCH_DATE.getTime()) / yearsMs),
  );
  return LIFETIME_BASE_SATS + years * LIFETIME_STEP_SATS;
}

export interface PendingLifetimeInvoice {
  pubkey: string;
  invoiceId: string;
  amountSats: number;
  createdAt: number;
}

export class LifetimeStore {
  constructor(private readonly redis: Redis) {}

  /** Has this pubkey paid for the lifetime tier? */
  async isPaid(pubkey: string): Promise<boolean> {
    return (await this.redis.exists(LIFETIME_PREFIX + pubkey)) === 1;
  }

  /** Unix seconds of the payment, or null if not a lifetime member. */
  async paidAt(pubkey: string): Promise<number | null> {
    const raw = await this.redis.get(LIFETIME_PREFIX + pubkey);
    return raw ? Number.parseInt(raw, 10) : null;
  }

  /** Idempotent — re-calling with a fresh timestamp leaves the original. */
  async markPaid(pubkey: string, at = Math.floor(Date.now() / 1000)): Promise<void> {
    // NX so the timestamp of the *first* settlement wins — a later
    // admin stamp doesn't overwrite the real BTCPay paid-at.
    const result = await this.redis.set(LIFETIME_PREFIX + pubkey, String(at), 'NX');
    // Lifetime members are registered Deepmarks users — keep the
    // relay's writePolicy in sync. Lazy-imported to avoid a circular
    // dep between lifetime.ts and registry.ts (which imports a Redis
    // type chain back here in some build configs).
    const { registerPubkey, LIFETIME_ARCHIVE_QUEUE } = await import('./registry.js');
    void registerPubkey(this.redis, pubkey);
    // First-time settlement → schedule archive backfill so this new
    // lifetime member's existing public bookmarks get archived
    // server-side. Don't enqueue on subsequent calls (idempotent
    // admin stamps shouldn't re-trigger work).
    if (result === 'OK') {
      await this.redis.lpush(LIFETIME_ARCHIVE_QUEUE, pubkey.toLowerCase()).catch(() => undefined);
    }
  }

  /**
   * Record that we're awaiting settlement of a BTCPay invoice for this
   * pubkey. Used to tie the webhook delivery back to the buyer if the
   * invoice metadata ever gets stripped / mangled.
   */
  async stagePending(record: PendingLifetimeInvoice): Promise<void> {
    await this.redis.set(
      PENDING_PREFIX + record.invoiceId,
      JSON.stringify(record),
      'EX',
      PENDING_TTL_SECONDS,
    );
  }

  async getPending(invoiceId: string): Promise<PendingLifetimeInvoice | null> {
    const raw = await this.redis.get(PENDING_PREFIX + invoiceId);
    return raw ? (JSON.parse(raw) as PendingLifetimeInvoice) : null;
  }

  async clearPending(invoiceId: string): Promise<void> {
    await this.redis.del(PENDING_PREFIX + invoiceId);
  }

  /**
   * Enumerate current lifetime members. Uses SCAN to avoid blocking Redis
   * on large keysets (KEYS is O(n) and stalls the single-threaded server).
   * Returns [pubkey, paidAt] pairs sorted by paidAt ascending.
   */
  async listMembers(): Promise<Array<{ pubkey: string; paidAt: number }>> {
    const out: Array<{ pubkey: string; paidAt: number }> = [];
    let cursor = '0';
    do {
      const [next, keys] = (await this.redis.scan(
        cursor,
        'MATCH',
        `${LIFETIME_PREFIX}*`,
        'COUNT',
        100,
      )) as [string, string[]];
      cursor = next;
      if (keys.length === 0) continue;
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const pubkey = keys[i].slice(LIFETIME_PREFIX.length);
        const paidAt = Number.parseInt(values[i] ?? '0', 10);
        if (paidAt > 0) out.push({ pubkey, paidAt });
      }
    } while (cursor !== '0');
    out.sort((a, b) => a.paidAt - b.paidAt);
    return out;
  }
}
