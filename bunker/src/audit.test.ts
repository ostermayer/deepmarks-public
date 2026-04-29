import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from './audit.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-audit-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('AuditLog', () => {
  it('creates parent directory if missing', () => {
    const p = path.join(tmp, 'nested', 'dir', 'audit.jsonl');
    new AuditLog(p);
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });

  it('appends one JSON line per call', () => {
    const p = path.join(tmp, 'audit.jsonl');
    const log = new AuditLog(p);
    log.append({
      ts: 1_700_000_000,
      clientPubkey: 'a'.repeat(64),
      identity: 'brand',
      kind: 9735,
      outcome: 'accepted',
      eventId: 'e'.repeat(64),
    });
    log.append({
      ts: 1_700_000_001,
      clientPubkey: 'b'.repeat(64),
      identity: 'unknown',
      kind: null,
      outcome: 'rejected',
      reason: 'unknown client pubkey',
    });
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const [a, b] = lines.map((l) => JSON.parse(l));
    expect(a.outcome).toBe('accepted');
    expect(a.eventId).toBe('e'.repeat(64));
    expect(b.outcome).toBe('rejected');
    expect(b.reason).toBe('unknown client pubkey');
  });
});
