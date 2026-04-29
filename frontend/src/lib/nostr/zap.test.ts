import { describe, it, expect } from 'vitest';
import { planZap, buildZapRequestTags } from './zap.js';
import type { ParsedBookmark } from './bookmarks.js';

const baseBookmark: ParsedBookmark = {
  url: 'https://x.test',
  title: 't',
  description: '',
  tags: [],
  archivedForever: false,
  savedAt: 0,
  curator: 'curator-pubkey',
  eventId: 'e1'
};

describe('planZap — happy path 80/10/10', () => {
  it('splits 80/10/10 when curator LN + site operator LN are both present', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, 'zap@deepmarks.org', 'curator@me.com');
    expect(plan.recipients).toHaveLength(3);
    const byLabel = Object.fromEntries(plan.recipients.map((r) => [r.label, r.millisats]));
    expect(byLabel['curator@me.com']).toBe(800_000);
    expect(byLabel['site@operator.com']).toBe(100_000);
    expect(byLabel['deepmarks']).toBe(100_000);
    // Sum exactly equals totalMsats — no rounding leak in either direction.
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(1_000_000);
  });

  it('attaches the curator pubkey on the curator leg for NIP-57 receipt routing', () => {
    const plan = planZap(baseBookmark, 100, 'zap@deepmarks.org', 'curator@me.com');
    const curator = plan.recipients.find((r) => r.label === 'curator@me.com');
    expect(curator?.pubkey).toBe('curator-pubkey');
  });

  it('ordering is curator → operator → deepmarks (UI convention)', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, 'zap@deepmarks.org', 'curator@me.com');
    expect(plan.recipients.map((r) => r.label)).toEqual([
      'curator@me.com',
      'site@operator.com',
      'deepmarks',
    ]);
  });
});

describe('planZap — fallback when LN addresses are missing', () => {
  it('rolls the curator share into @deepmarks when the curator has no LN address', () => {
    const bm = { ...baseBookmark, lightning: 'site@operator.com' };
    const plan = planZap(bm, 1000, 'zap@deepmarks.org', null);
    expect(plan.recipients).toHaveLength(2);
    const byLabel = Object.fromEntries(plan.recipients.map((r) => [r.label, r.millisats]));
    // Operator's 10% stays; deepmarks gets its 10% + curator's 80% = 90%.
    expect(byLabel['site@operator.com']).toBe(100_000);
    expect(byLabel['deepmarks']).toBe(900_000);
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(1_000_000);
  });

  it('rolls the operator share into @deepmarks when the site LN is not detected', () => {
    // No bookmark.lightning → no operator recipient.
    const plan = planZap(baseBookmark, 1000, 'zap@deepmarks.org', 'curator@me.com');
    expect(plan.recipients).toHaveLength(2);
    const byLabel = Object.fromEntries(plan.recipients.map((r) => [r.label, r.millisats]));
    expect(byLabel['curator@me.com']).toBe(800_000);
    // Deepmarks gets 10% base + 10% reclaimed from missing operator = 20%.
    expect(byLabel['deepmarks']).toBe(200_000);
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(1_000_000);
  });

  it('routes the full amount to @deepmarks when neither curator nor operator have a LN address', () => {
    const plan = planZap(baseBookmark, 1000, 'zap@deepmarks.org', null);
    expect(plan.recipients).toHaveLength(1);
    expect(plan.recipients[0]?.label).toBe('deepmarks');
    expect(plan.recipients[0]?.millisats).toBe(1_000_000);
  });

  it('never produces an empty-string lightning on any recipient, regardless of fallback path', () => {
    // Every variant: missing curator, missing operator, both missing, both present.
    const variants: Array<[ParsedBookmark, string | null]> = [
      [baseBookmark, null],
      [baseBookmark, 'c@x'],
      [{ ...baseBookmark, lightning: 's@y' }, null],
      [{ ...baseBookmark, lightning: 's@y' }, 'c@x'],
    ];
    for (const [bm, curator] of variants) {
      const plan = planZap(bm, 1000, 'zap@deepmarks.org', curator);
      for (const r of plan.recipients) {
        expect(r.lightning).not.toBe('');
      }
    }
  });
});

describe('planZap — totals', () => {
  it('sum always equals totalMsats even with uneven splits (no rounding leak)', () => {
    // 333 sats forces remainders on the 10% and 80% computations.
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    const plan = planZap(bm, 333, 'zap@deepmarks.org', 'me@x.com');
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(333 * 1000);
  });

  it('every leg is a whole-sat amount so LNURL callbacks accept it', () => {
    // LNURL endpoints reject non-multiple-of-1000 msat amounts. Verify
    // every recipient's millisats field is a clean sat boundary across
    // a range of totals that would otherwise produce fractional splits.
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    for (const total of [21, 42, 333, 1000, 1001, 21000]) {
      const plan = planZap(bm, total, 'zap@deepmarks.org', 'me@x.com');
      for (const r of plan.recipients) {
        expect(r.millisats % 1000).toBe(0);
        expect(r.millisats).toBeGreaterThan(0);
      }
      const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
      expect(sum).toBe(total * 1000);
    }
  });

  it('remainder lands on @deepmarks, never on the curator or operator', () => {
    // 333 sats: curator 80% = 266.4 → rounds to 266, operator 10% = 33.3
    // → rounds to 33, deepmarks absorbs 333-266-33 = 34.
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    const plan = planZap(bm, 333, 'zap@deepmarks.org', 'me@x.com');
    const byLabel = Object.fromEntries(plan.recipients.map((r) => [r.label, r.millisats]));
    expect(byLabel['me@x.com']).toBe(Math.round(333 * 0.8) * 1000);
    expect(byLabel['site@op.com']).toBe(Math.round(333 * 0.1) * 1000);
    expect(byLabel['deepmarks']).toBe(
      333_000 - Math.round(333 * 0.8) * 1000 - Math.round(333 * 0.1) * 1000,
    );
  });

  it('drops a leg that would round to zero sats rather than sending a sub-sat amount', () => {
    // 5 sats: operator 10% = 0.5 → rounds to 1 sat, no drop;
    // 4 sats: operator 10% = 0.4 → rounds to 0 sat, dropped, share merges into deepmarks.
    const bm = { ...baseBookmark, lightning: 'site@op.com' };
    const plan = planZap(bm, 4, 'zap@deepmarks.org', 'me@x.com');
    const labels = plan.recipients.map((r) => r.label);
    expect(labels).not.toContain('site@op.com');
    const sum = plan.recipients.reduce((s, r) => s + r.millisats, 0);
    expect(sum).toBe(4000);
  });
});

describe('buildZapRequestTags', () => {
  const recipient = {
    label: 'deepmarks',
    lightning: 'zap@deepmarks.org',
    millisats: 21000,
    pubkey: 'recip-pubkey'
  };

  it('always includes relays / amount / lnurl', () => {
    const tags = buildZapRequestTags(recipient, { eventId: 'e1' });
    const keys = tags.map((t) => t[0]);
    expect(keys).toContain('relays');
    expect(keys).toContain('amount');
    expect(keys).toContain('lnurl');
    const amount = tags.find((t) => t[0] === 'amount');
    expect(amount?.[1]).toBe('21000');
  });

  it('omits p when no recipient pubkey is known', () => {
    const tags = buildZapRequestTags({ ...recipient, pubkey: undefined }, { eventId: 'e1' });
    expect(tags.find((t) => t[0] === 'p')).toBeUndefined();
  });

  it('omits e when bookmark has no eventId (zapping a profile not a bookmark)', () => {
    const tags = buildZapRequestTags(recipient, { eventId: '' });
    expect(tags.find((t) => t[0] === 'e')).toBeUndefined();
  });

  it('emits no empty-string tag values that the relay would reject', () => {
    const tags = buildZapRequestTags({ ...recipient, pubkey: undefined }, { eventId: '' });
    for (const t of tags) {
      for (const cell of t) {
        expect(cell).not.toBe('');
      }
    }
  });
});
