import { describe, expect, it } from 'vitest';

import { planPublishRelayRetry } from '@src/workers/relay-fanout.js';

describe('planPublishRelayRetry', () => {
  it('backs off rate-limit errors instead of retrying immediately', () => {
    expect(planPublishRelayRetry(1, new Error('rate limit (200/hour per pubkey)'))).toEqual({
      action: 'retry',
      reason: 'rate-limit',
      delayMs: 10 * 60_000,
    });
    expect(planPublishRelayRetry(3, new Error('too many requests'))).toEqual({
      action: 'retry',
      reason: 'rate-limit',
      delayMs: 30 * 60_000,
    });
  });

  it('uses capped exponential backoff for transient relay failures', () => {
    expect(planPublishRelayRetry(1, new Error('publish timeout after 4000ms'))).toEqual({
      action: 'retry',
      reason: 'transient',
      delayMs: 1_000,
    });
    expect(planPublishRelayRetry(8, new Error('publish timeout after 4000ms'))).toEqual({
      action: 'retry',
      reason: 'transient',
      delayMs: 60_000,
    });
  });

  it('drops once the transient retry budget is exhausted', () => {
    expect(planPublishRelayRetry(9, new Error('connection reset'))).toEqual({
      action: 'drop',
      reason: 'attempts-exhausted',
    });
  });

  it('gives rate-limited events the longer 30-attempt budget', () => {
    // Rate limiting isn't a failure — the event lands once the hourly
    // window refills, so bulk imports drain instead of dropping at 8.
    expect(planPublishRelayRetry(9, new Error('rate limit')).action).toBe('retry');
    expect(planPublishRelayRetry(31, new Error('rate limit'))).toEqual({
      action: 'drop',
      reason: 'attempts-exhausted',
    });
  });
});
