import { describe, it, expect } from 'vitest';
import { allowedKindsFor, checkPermission } from './permissions.js';

const AUTHORIZED = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('checkPermission', () => {
  it('accepts brand signing kind 9735', () => {
    expect(
      checkPermission(
        { authorizedClient: AUTHORIZED },
        { clientPubkey: AUTHORIZED, identity: 'brand', kind: 9735 },
      ),
    ).toEqual({ ok: true });
  });

  it('accepts brand signing kind 1985', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: AUTHORIZED, identity: 'brand', kind: 1985 },
    );
    expect(r.ok).toBe(true);
  });

  it('accepts personal signing kind 9735', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: AUTHORIZED, identity: 'personal', kind: 9735 },
    );
    expect(r.ok).toBe(true);
  });

  it('rejects personal signing kind 1985 (brand-only)', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: AUTHORIZED, identity: 'personal', kind: 1985 },
    );
    expect(r).toEqual({ ok: false, reason: 'kind 1985 not allowed for personal' });
  });

  it('rejects kind 1 (note) for both identities', () => {
    for (const identity of ['brand', 'personal'] as const) {
      const r = checkPermission(
        { authorizedClient: AUTHORIZED },
        { clientPubkey: AUTHORIZED, identity, kind: 1 },
      );
      expect(r.ok).toBe(false);
    }
  });

  it('rejects kind 0 (profile) for both identities', () => {
    for (const identity of ['brand', 'personal'] as const) {
      const r = checkPermission(
        { authorizedClient: AUTHORIZED },
        { clientPubkey: AUTHORIZED, identity, kind: 0 },
      );
      expect(r.ok).toBe(false);
    }
  });

  it('rejects kind 5 (deletion) for both identities', () => {
    for (const identity of ['brand', 'personal'] as const) {
      const r = checkPermission(
        { authorizedClient: AUTHORIZED },
        { clientPubkey: AUTHORIZED, identity, kind: 5 },
      );
      expect(r.ok).toBe(false);
    }
  });

  it('rejects unauthorized client pubkeys even for allowed kinds', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: OTHER, identity: 'brand', kind: 9735 },
    );
    expect(r).toEqual({ ok: false, reason: 'unknown client pubkey' });
  });

  it('rejects unknown identities', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { clientPubkey: AUTHORIZED, identity: 'mystery' as any, kind: 9735 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown identity');
  });
});

describe('allowedKindsFor', () => {
  it('exposes the brand allowlist (9735 + 1985 + 39701)', () => {
    const s = allowedKindsFor('brand');
    expect(s.has(9735)).toBe(true);
    expect(s.has(1985)).toBe(true);
    expect(s.has(39701)).toBe(true);
    expect(s.has(1)).toBe(false);
    expect(s.has(0)).toBe(false);
    expect(s.size).toBe(3);
  });

  it('exposes the personal allowlist (9735 only)', () => {
    const s = allowedKindsFor('personal');
    expect(s.has(9735)).toBe(true);
    expect(s.has(1985)).toBe(false);
    expect(s.has(39701)).toBe(false);
    expect(s.size).toBe(1);
  });
});

describe('kind 39701 (public web bookmark) allowed for brand only', () => {
  const AUTHORIZED = 'a'.repeat(64);
  it('brand can sign 39701 for the Pinboard seeder', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: AUTHORIZED, identity: 'brand', kind: 39701 },
    );
    expect(r.ok).toBe(true);
  });
  it('personal cannot sign 39701', () => {
    const r = checkPermission(
      { authorizedClient: AUTHORIZED },
      { clientPubkey: AUTHORIZED, identity: 'personal', kind: 39701 },
    );
    expect(r.ok).toBe(false);
  });
});
