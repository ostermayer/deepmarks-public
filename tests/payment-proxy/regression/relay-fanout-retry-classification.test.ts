// Regression guards for audit findings RELAY-F1 / RELAY-F5 (2026-06 review):
// after /publish returns 202 the relay-fanout worker is the only thing
// standing between the queue and the actual relay. Its retry planner only
// distinguishes "rate limit" from "everything else": deterministic policy
// rejections from strfry's writePolicy ("pubkey not registered", "kind not
// accepted", "too old", clock skew) are retried as transient up to the
// attempt cap and then silently dropped — the client was already told the
// save succeeded.
//
// FIXED: deterministic rejections are now classified and dead-lettered
// immediately (dm:publish-relay:dead) — these tests are permanent guards.

import { describe, expect, it } from 'vitest';
import { planPublishRelayRetry } from '@src/workers/relay-fanout.js';

describe('planPublishRelayRetry', () => {
  it('backs off long on relay rate limits instead of burning the next window (baseline)', () => {
    const plan = planPublishRelayRetry(2, new Error('rate limit (200/hour per pubkey)'));
    expect(plan.action).toBe('retry');
    expect(plan.reason).toBe('rate-limit');
    if (plan.action === 'retry') {
      expect(plan.delayMs).toBeGreaterThanOrEqual(10 * 60_000);
    }
  });

  it('retries genuinely transient failures with exponential backoff (baseline)', () => {
    const plan = planPublishRelayRetry(1, new Error('connect ECONNREFUSED 127.0.0.1:7777'));
    expect(plan.action).toBe('retry');
    expect(plan.reason).toBe('transient');
  });

  it('stops once the attempt budget is exhausted (baseline)', () => {
    const plan = planPublishRelayRetry(99, new Error('anything'));
    expect(plan.action).toBe('drop');
  });

  // These rejections are deterministic — re-sending the same event can
  // never succeed, and each retry burns rate-limit window for the user's
  // other events. They are dead-lettered immediately instead of being
  // retried as "transient" and then dropped.
  it('does not blind-retry deterministic policy rejections', () => {
    const deterministic = [
      'pubkey not registered with deepmarks — sign in at https://deepmarks.org first',
      'kind 30023 not accepted on this relay',
      'event is too old',
      'event created_at is too far in the future',
    ];
    for (const reason of deterministic) {
      const plan = planPublishRelayRetry(1, new Error(reason));
      expect(plan.action, `"${reason}" should not be retried as transient`).toBe('drop');
    }
  });
});
