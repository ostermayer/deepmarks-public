// Append-only audit log. Every sign request lands here regardless of
// outcome — approved, rejected, or errored. One JSON object per line so
// the file is trivially tailable + grep-able. Rotation is logrotate's job.

import fs from 'node:fs';
import path from 'node:path';
import type { IdentityName } from './permissions.js';

export interface AuditEntry {
  /** Unix seconds. */
  ts: number;
  clientPubkey: string;
  identity: IdentityName | 'unknown';
  kind: number | null;
  /** 'accepted' means we signed + responded. 'rejected' = permission check
   *  failed. 'errored' = something unexpected. */
  outcome: 'accepted' | 'rejected' | 'errored';
  /** Non-empty on reject/error; short human-readable phrase. */
  reason?: string;
  /** Hex event id we returned, when outcome=accepted. */
  eventId?: string;
}

export class AuditLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    // Ensure parent dir exists — the compose mount creates it, but locally
    // in tests we want a friendly auto-create.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    // appendFileSync over a stream: we want each line fully flushed before
    // the bunker acks the network request. ~3KB/line × low rate → plenty
    // fast, and we don't risk losing the last write on SIGTERM.
    try {
      fs.appendFileSync(this.filePath, line, { encoding: 'utf8' });
    } catch (err) {
      // Disk full / permission flip / mount gone. Without a fallback the
      // throw propagates up through handler.ts, where the outer catch
      // calls audit.append AGAIN (which throws again), eventually killing
      // the request silently. Worse: every signing operation goes
      // through audit.append, so a broken audit file means signing
      // stops working with no visible error trail. Mirror to stderr so
      // an operator at least sees what they lost.
      try {
        process.stderr.write(`[audit-fallback] ${(err as Error).message} :: ${line}`);
      } catch {
        // stderr also broken — give up; nothing useful we can do.
      }
    }
  }

  /** Returns the file path so the operator can tail it. */
  get path(): string {
    return this.filePath;
  }
}
