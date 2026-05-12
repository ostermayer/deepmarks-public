import { describe, it, expect, vi } from 'vitest';
import type { AuthenticatedLnd } from 'lightning';
import {
  SubscriptionCircuitBreaker,
  classifyVoltageError,
  validateVoltageConnection,
} from './voltage.js';

// ── classifyVoltageError — convert raw lightning-pkg errors to hints ────

describe('classifyVoltageError', () => {
  it('recognises a 404 as "gRPC port is probably wrong"', () => {
    const r = classifyVoltageError([503, 'UnexpectedError', {
      err: { code: 12, details: 'Received HTTP status code 404' }
    }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hint).toMatch(/gRPC/);
      expect(r.hint).toMatch(/10009/);
    }
  });

  it('recognises "unimplemented" gRPC status (REST endpoint hit) as the same misconfig', () => {
    const r = classifyVoltageError([501, 'Unimplemented', {
      err: { details: 'unimplemented method' }
    }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/gRPC/);
  });

  it('recognises a permission error as "wrong macaroon"', () => {
    const r = classifyVoltageError([401, 'Unauthorized', {
      err: { details: 'permission denied: cannot invoke addinvoice' }
    }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/invoice-only|macaroon/i);
  });

  it('recognises unreachable hostname / connection refused', () => {
    const r = classifyVoltageError(new Error('getaddrinfo ENOTFOUND bogus.voltageapp.io'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/reachable|online/);
  });

  it('falls back to a generic reason when nothing matches', () => {
    const r = classifyVoltageError(new Error('something weird happened'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/weird/);
      expect(r.hint).toBeUndefined();
    }
  });

  it('clips pathologically long error text', () => {
    const r = classifyVoltageError(new Error('x'.repeat(5000)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeLessThan(500);
  });
});

// ── validateVoltageConnection — the one-shot boot check ────────────────

describe('validateVoltageConnection', () => {
  const fakeLnd = {} as AuthenticatedLnd;

  it('returns ok when createInvoice succeeds', async () => {
    const r = await validateVoltageConnection(
      fakeLnd,
      async () => ({ id: 'hash', request: 'lnbc1…', tokens: 1 }) as never,
    );
    expect(r.ok).toBe(true);
  });

  it('funnels a thrown 404-style error through classifyVoltageError', async () => {
    const r = await validateVoltageConnection(
      fakeLnd,
      async () => {
        throw [503, 'UnexpectedError', {
          err: { code: 12, details: 'Received HTTP status code 404' }
        }];
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/gRPC/);
  });

  it('never performs more than one call (no retry at this layer)', async () => {
    const spy = vi.fn(async () => ({ id: 'h', request: 'r', tokens: 1 }) as never);
    await validateVoltageConnection(fakeLnd, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── SubscriptionCircuitBreaker — cap reconnect logging ─────────────────

describe('SubscriptionCircuitBreaker', () => {
  it('returns "continue" below the ceiling, "trip" on the ceiling, "silent" thereafter', () => {
    const b = new SubscriptionCircuitBreaker(3, 60_000);
    expect(b.recordError()).toBe('continue');
    expect(b.recordError()).toBe('continue');
    expect(b.recordError()).toBe('trip');
    expect(b.recordError()).toBe('silent');
    expect(b.recordError()).toBe('silent');
    expect(b.isTripped).toBe(true);
    expect(b.errorCount).toBe(3);
  });

  it('a success fully resets the state — no residual error count', () => {
    const b = new SubscriptionCircuitBreaker(3, 60_000);
    b.recordError();
    b.recordError();
    b.recordSuccess();
    expect(b.errorCount).toBe(0);
    expect(b.isTripped).toBe(false);
    expect(b.recordError()).toBe('continue');
  });

  it('a success after trip re-arms the breaker', () => {
    const b = new SubscriptionCircuitBreaker(2, 60_000);
    b.recordError();
    b.recordError(); // trip
    expect(b.isTripped).toBe(true);
    b.recordSuccess();
    expect(b.isTripped).toBe(false);
    expect(b.recordError()).toBe('continue');
  });

  it('errors outside the rolling window don\'t accumulate', () => {
    let now = 0;
    const b = new SubscriptionCircuitBreaker(3, 1000, () => now);
    b.recordError(); // at t=0
    now = 500;
    b.recordError();
    now = 10_000; // way past window
    expect(b.recordError()).toBe('continue');
    expect(b.errorCount).toBe(1); // reset + first new error
  });

  it('defaults to 5 failures in 5 minutes when constructed without args', () => {
    const b = new SubscriptionCircuitBreaker();
    expect(b.ceiling).toBe(5);
    expect(b.windowMs).toBe(5 * 60 * 1000);
  });
});
