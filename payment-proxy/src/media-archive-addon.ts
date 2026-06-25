import type { Redis } from 'ioredis';

export const MEDIA_ARCHIVE_ADDON_PRICE_SATS = 150_000;

const ENTITLEMENT_PREFIX = 'dm:media-archive-addon:';
const PENDING_PREFIX = 'dm:media-archive-addon-pending:';
const PENDING_TTL_SECONDS = 24 * 60 * 60;

export interface PendingMediaArchiveAddonInvoice {
  pubkey: string;
  invoiceId: string;
  amountSats: number;
  createdAt: number;
}

export class MediaArchiveAddonStore {
  constructor(private readonly redis: Redis) {}

  async isPaid(pubkey: string): Promise<boolean> {
    return (await this.redis.exists(ENTITLEMENT_PREFIX + pubkey)) === 1;
  }

  async paidAt(pubkey: string): Promise<number | null> {
    const raw = await this.redis.get(ENTITLEMENT_PREFIX + pubkey);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }

  async markPaid(pubkey: string, paidAt = Math.floor(Date.now() / 1000)): Promise<void> {
    await this.redis.set(ENTITLEMENT_PREFIX + pubkey, String(paidAt), 'NX');
  }

  async stagePending(record: PendingMediaArchiveAddonInvoice): Promise<void> {
    await this.redis.set(
      PENDING_PREFIX + record.invoiceId,
      JSON.stringify(record),
      'EX',
      PENDING_TTL_SECONDS,
    );
  }

  async getPending(invoiceId: string): Promise<PendingMediaArchiveAddonInvoice | null> {
    const raw = await this.redis.get(PENDING_PREFIX + invoiceId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingMediaArchiveAddonInvoice>;
      if (
        typeof parsed.pubkey === 'string' &&
        /^[0-9a-f]{64}$/i.test(parsed.pubkey) &&
        typeof parsed.invoiceId === 'string' &&
        typeof parsed.amountSats === 'number' &&
        typeof parsed.createdAt === 'number'
      ) {
        return {
          pubkey: parsed.pubkey.toLowerCase(),
          invoiceId: parsed.invoiceId,
          amountSats: Math.floor(parsed.amountSats),
          createdAt: Math.floor(parsed.createdAt),
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  async clearPending(invoiceId: string): Promise<void> {
    await this.redis.del(PENDING_PREFIX + invoiceId);
  }

  async listMembers(): Promise<Array<{ pubkey: string; paidAt: number }>> {
    const out: Array<{ pubkey: string; paidAt: number }> = [];
    let cursor = '0';
    do {
      const [next, keys] = (await this.redis.scan(
        cursor,
        'MATCH',
        `${ENTITLEMENT_PREFIX}*`,
        'COUNT',
        100,
      )) as [string, string[]];
      cursor = next;
      if (keys.length === 0) continue;
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const pubkey = keys[i]?.slice(ENTITLEMENT_PREFIX.length) ?? '';
        const paidAt = Number.parseInt(values[i] ?? '0', 10);
        if (/^[0-9a-f]{64}$/i.test(pubkey) && paidAt > 0) out.push({ pubkey: pubkey.toLowerCase(), paidAt });
      }
    } while (cursor !== '0');
    out.sort((a, b) => a.paidAt - b.paidAt);
    return out;
  }
}
