import { describe, it, expect } from 'vitest';
import {
  buildZapRequestTags,
  decodeLnurlPayUrl,
  encodeLnurlPayUrl,
  lightningUriForInvoice,
  lightningAddressToPayUrl,
  planZap,
  zappedBookmarkEventIdsFromReceipt,
} from '$lib/nostr/zap.js';
import type { ParsedBookmark } from '$lib/nostr/bookmarks.js';

const CURATOR_PUBKEY = 'c'.repeat(64);
const EVENT_ID = 'e'.repeat(64);
const RECIPIENT_PUBKEY = 'f'.repeat(64);
const RECIPIENT_LNURL = encodeLnurlPayUrl('https://curator.example/.well-known/lnurlp/zap');

const baseBookmark: ParsedBookmark = {
  url: 'https://x.test',
  title: 't',
  description: '',
  tags: [],
  archivedForever: false,
  savedAt: 0,
  curator: CURATOR_PUBKEY,
  eventId: EVENT_ID,
};

describe('planZap — single recipient', () => {
  it('routes 100% to the curator even when a site Lightning address is present', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, 'curator@me.com');

    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0]).toMatchObject({
      label: 'curator@me.com',
      lightning: 'curator@me.com',
      pubkey: CURATOR_PUBKEY,
      millisats: 1_000_000,
    });
    expect(plan.totalMsats).toBe(1_000_000);
  });

  it('attaches the curator pubkey on the curator leg for NIP-57 receipt routing', () => {
    const plan = planZap(baseBookmark, 100, 'curator@me.com');
    const curator = plan.recipients.find((r) => r.label === 'curator@me.com');
    expect(curator?.pubkey).toBe(CURATOR_PUBKEY);
  });

  it('does not create a site-operator recipient', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, 'curator@me.com');
    expect(plan.recipients.map((r) => r.label)).toEqual(['curator@me.com']);
  });

  it('routes 100% to Deepmarks when the curator has no Lightning address', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, null, 'zap@deepmarks.org');
    expect(plan.recipients).toEqual([
      {
        label: 'deepmarks',
        lightning: 'zap@deepmarks.org',
        millisats: 1_000_000,
      },
    ]);
    expect(plan.totalMsats).toBe(1_000_000);
  });

  it('drops the recipient when total is not positive', () => {
    expect(planZap(baseBookmark, 0, 'curator@me.com').recipients).toEqual([]);
  });
});

describe('planZap — totals', () => {
  it('single recipient sum equals totalMsats', () => {
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    const plan = planZap(bm, 333, 'me@x.com');
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(333 * 1000);
  });

  it('every curator payment is a whole-sat amount so LNURL callbacks accept it', () => {
    // LNURL endpoints reject non-multiple-of-1000 msat amounts. Verify
    // the recipient's millisats field is a clean sat boundary.
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    for (const total of [21, 42, 333, 1000, 1001, 21000]) {
      const plan = planZap(bm, total, 'me@x.com');
      for (const r of plan.recipients) {
        expect(r.millisats % 1000).toBe(0);
        expect(r.millisats).toBeGreaterThan(0);
      }
      const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
      expect(sum).toBe(total * 1000);
    }
  });
});

describe('buildZapRequestTags', () => {
  const recipient = {
    label: 'curator@me.com',
    lightning: 'curator@me.com',
    millisats: 21000,
    pubkey: RECIPIENT_PUBKEY,
  };

  it('always includes p / relays / amount / lnurl', () => {
    const tags = buildZapRequestTags(recipient, { eventId: EVENT_ID }, RECIPIENT_LNURL, RECIPIENT_PUBKEY);
    const keys = tags.map((t) => t[0]);
    expect(keys).toContain('p');
    expect(keys).toContain('relays');
    expect(keys).toContain('amount');
    expect(keys).toContain('lnurl');
    expect(tags.find((t) => t[0] === 'p')?.[1]).toBe(RECIPIENT_PUBKEY);
    const amount = tags.find((t) => t[0] === 'amount');
    expect(amount?.[1]).toBe('21000');
    const lnurl = tags.find((t) => t[0] === 'lnurl');
    expect(lnurl?.[1]).toBe(RECIPIENT_LNURL);
  });

  it('marks bookmark zaps with e and k tags', () => {
    const tags = buildZapRequestTags(recipient, { eventId: EVENT_ID }, RECIPIENT_LNURL, RECIPIENT_PUBKEY);
    expect(tags.find((t) => t[0] === 'e')?.[1]).toBe(EVENT_ID);
    expect(tags.find((t) => t[0] === 'k')?.[1]).toBe('39701');
  });

  it('omits e when bookmark has no eventId (zapping a profile not a bookmark)', () => {
    const tags = buildZapRequestTags(recipient, { eventId: '' }, RECIPIENT_LNURL, RECIPIENT_PUBKEY);
    expect(tags.find((t) => t[0] === 'e')).toBeUndefined();
    expect(tags.find((t) => t[0] === 'k')).toBeUndefined();
  });

  it('targets the source kind:1 event for links found in friends notes', () => {
    const sourceEventId = 'a'.repeat(64);
    const tags = buildZapRequestTags(
      recipient,
      {
        eventId: `note-link:${sourceEventId}:0`,
        source: 'nostr-note-link',
        sourceEventId,
        sourceEventKind: 1,
      },
      RECIPIENT_LNURL,
      RECIPIENT_PUBKEY,
    );

    expect(tags.find((t) => t[0] === 'e')?.[1]).toBe(sourceEventId);
    expect(tags.find((t) => t[0] === 'k')?.[1]).toBe('1');
  });

  it('does not emit a fake synthetic row id as a zap target', () => {
    const tags = buildZapRequestTags(
      recipient,
      { eventId: 'note-link:not-a-real-event:0' },
      RECIPIENT_LNURL,
      RECIPIENT_PUBKEY,
    );

    expect(tags.find((t) => t[0] === 'e')).toBeUndefined();
    expect(tags.find((t) => t[0] === 'k')).toBeUndefined();
  });

  it('emits no empty-string tag values that the relay would reject', () => {
    const tags = buildZapRequestTags(recipient, { eventId: '' }, RECIPIENT_LNURL, RECIPIENT_PUBKEY);
    for (const t of tags) {
      for (const cell of t) {
        expect(cell).not.toBe('');
      }
    }
  });
});

describe('zappedBookmarkEventIdsFromReceipt', () => {
  const ZAPPER_PUBKEY = 'a'.repeat(64);
  const OTHER_PUBKEY = 'b'.repeat(64);

  function receiptFor(pubkey: string, tags: string[][], receiptTags: string[][] = []) {
    return [
      ['description', JSON.stringify({ kind: 9734, pubkey, tags, content: '' })],
      ...receiptTags,
    ];
  }

  it('extracts bookmark ids from the embedded zap request authored by the zapper', () => {
    expect(zappedBookmarkEventIdsFromReceipt(receiptFor(ZAPPER_PUBKEY, [['e', EVENT_ID]]), ZAPPER_PUBKEY))
      .toEqual([EVENT_ID]);
  });

  it('ignores receipts for other zappers', () => {
    expect(zappedBookmarkEventIdsFromReceipt(receiptFor(OTHER_PUBKEY, [['e', EVENT_ID]]), ZAPPER_PUBKEY))
      .toEqual([]);
  });

  it('uses the receipt e tag when the description was stripped down', () => {
    const tags = receiptFor(ZAPPER_PUBKEY, [], [['e', EVENT_ID]]);
    expect(zappedBookmarkEventIdsFromReceipt(tags, ZAPPER_PUBKEY)).toEqual([EVENT_ID]);
  });

  it('accepts a receipt P tag plus e tag when no description is present', () => {
    expect(zappedBookmarkEventIdsFromReceipt([['P', ZAPPER_PUBKEY], ['e', EVENT_ID]], ZAPPER_PUBKEY))
      .toEqual([EVENT_ID]);
  });

  it('rejects malformed receipt descriptions', () => {
    expect(zappedBookmarkEventIdsFromReceipt([['description', '{bad json'], ['e', EVENT_ID]], ZAPPER_PUBKEY))
      .toEqual([]);
  });
});

describe('LNURL helpers', () => {
  it('formats BOLT-11 invoices as lightning: wallet links', () => {
    expect(lightningUriForInvoice(' lnbc1deepmarksinvoice ')).toBe('lightning:lnbc1deepmarksinvoice');
  });

  it('turns a lightning address into the LUD-16 pay endpoint', () => {
    expect(lightningAddressToPayUrl('Ostermayer@Primal.net')).toBe(
      'https://primal.net/.well-known/lnurlp/Ostermayer',
    );
  });

  it('round-trips a pay URL as bech32 lnurl', () => {
    const payUrl = 'https://primal.net/.well-known/lnurlp/ostermayer';
    const lnurl = encodeLnurlPayUrl(payUrl);
    expect(lnurl).toMatch(/^lnurl1/);
    expect(decodeLnurlPayUrl(lnurl)).toBe(payUrl);
  });
});
