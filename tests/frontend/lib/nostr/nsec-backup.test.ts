import { describe, expect, it } from 'vitest';
import { buildNsecBackupText, nsecAsciiQr } from '$lib/nostr/nsec-backup';

const NSEC =
  'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const NPUB =
  'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

describe('nsec backup text', () => {
  it('includes the raw recovery key, public id, and an ASCII QR block', () => {
    const text = buildNsecBackupText({
      nsec: NSEC,
      npub: NPUB,
      createdAt: new Date('2026-05-15T12:00:00.000Z'),
    });

    expect(text).toContain(`# Generated 2026-05-15T12:00:00.000Z`);
    expect(text).toContain(`npub: ${NPUB}`);
    expect(text).toContain(`nsec: ${NSEC}`);
    expect(text).toContain('##');
    expect(text).not.toContain('undefined');
  });

  it('renders a stable text-only QR matrix', () => {
    const qr = nsecAsciiQr(NSEC);
    const lines = qr.split('\n');

    expect(lines.length).toBeGreaterThan(20);
    expect(lines.some((line) => line.includes('##'))).toBe(true);
    expect(lines.every((line) => /^[ #]*$/.test(line))).toBe(true);
  });
});
