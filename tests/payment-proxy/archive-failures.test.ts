import { describe, expect, it } from 'vitest';
import {
  archiveFailureMessage,
  classifyArchiveFailureReason,
  parseArchiveFailureRecord,
  shouldAlertArchiveFailure,
} from '../../payment-proxy/src/archive-failures.js';

describe('archive failure records', () => {
  it('classifies blocked-site archive failures from HTTP 403 style errors', () => {
    const reason = classifyArchiveFailureReason('page returned HTTP 403', 'permanent');

    expect(reason).toBe('site-blocked');
    expect(archiveFailureMessage(reason)).toBe('Site blocked the archive capture.');
    expect(shouldAlertArchiveFailure(reason, 'page returned HTTP 403')).toBe(false);
  });

  it('does not alert operators for remote page HTTP errors', () => {
    expect(shouldAlertArchiveFailure('failed', 'page returned HTTP 429')).toBe(false);
    expect(shouldAlertArchiveFailure('failed', 'renderer crashed')).toBe(true);
  });

  it('does not alert operators for stale jobs marked lost by archive audit', () => {
    expect(shouldAlertArchiveFailure('failed', 'archive job lost before completion — please retry')).toBe(false);
  });

  it('parses only failures owned by the expected pubkey', () => {
    const ownerPubkey = 'a'.repeat(64);
    const raw = JSON.stringify({
      jobId: 'lifetime:abc',
      ownerPubkey,
      url: 'https://archiveofourown.org/works/83355841',
      reason: 'site-blocked',
      message: 'Site blocked the archive capture.',
      error: 'page returned HTTP 403',
      failedAt: 1_700_000_000,
    });

    expect(parseArchiveFailureRecord(raw, ownerPubkey)?.reason).toBe('site-blocked');
    expect(parseArchiveFailureRecord(raw, 'b'.repeat(64))).toBeNull();
  });
});
