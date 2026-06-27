import { Redis } from 'ioredis';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const REPORT_PREFIX = 'dm:report:';
const PENDING_REPORTS = 'dm:reports:pending';
const ACTIONED_REPORTS = 'dm:reports:actioned';

export type ReportCategory =
  | 'csam'
  | 'illegal'
  | 'malware'
  | 'harassment'
  | 'copyright'
  | 'spam'
  | 'other';

export type TargetType = 'bookmark_event' | 'blob_hash' | 'pubkey';

export type ActionKind =
  | 'dismiss'
  | 'delist_index'
  | 'delist_relay'
  | 'delete_blob'
  | 'hash_blocklist'
  | 'url_blocklist'
  | 'suspend_pubkey';

export interface Report {
  id: string;
  target_type: TargetType;
  target_id: string; // event ID, blob hash, or pubkey
  category: ReportCategory;
  context?: string;
  reporter_email_hash?: string;
  reporter_pubkey?: string;
  submitted_at: number;
  status: 'pending' | 'actioned' | 'dismissed';
  actions?: Array<{ kind: ActionKind; at: number; admin: string; reason?: string }>;
  appeal_token?: string;
}

export class ReportStore {
  constructor(private readonly redis: Redis) {}

  async submit(params: {
    target_type: TargetType;
    target_id: string;
    category: ReportCategory;
    context?: string;
    reporter_email_hash?: string;
    reporter_pubkey?: string;
  }): Promise<Report> {
    const id = generateReportId();
    const report: Report = {
      id,
      target_type: params.target_type,
      target_id: params.target_id,
      category: params.category,
      context: params.context,
      reporter_email_hash: params.reporter_email_hash,
      reporter_pubkey: params.reporter_pubkey,
      submitted_at: Math.floor(Date.now() / 1000),
      status: 'pending',
    };

    await this.redis
      .multi()
      .set(REPORT_PREFIX + id, JSON.stringify(report))
      .zadd(PENDING_REPORTS, report.submitted_at, id)
      .exec();

    return report;
  }

  async get(id: string): Promise<Report | null> {
    const raw = await this.redis.get(REPORT_PREFIX + id);
    return raw ? (JSON.parse(raw) as Report) : null;
  }

  async listPending(limit = 50, offset = 0): Promise<Report[]> {
    // Oldest first so queue discipline is FIFO by default.
    const ids = await this.redis.zrange(PENDING_REPORTS, offset, offset + limit - 1);
    if (ids.length === 0) return [];
    const keys = ids.map((id) => REPORT_PREFIX + id);
    const raws = await this.redis.mget(...keys);
    return raws
      .filter((r): r is string => !!r)
      .map((r) => JSON.parse(r) as Report);
  }

  async recordAction(
    id: string,
    action: { kind: ActionKind; admin: string; reason?: string },
  ): Promise<Report | null> {
    const raw = await this.redis.get(REPORT_PREFIX + id);
    if (!raw) return null;
    const report = JSON.parse(raw) as Report;
    report.actions = report.actions ?? [];
    report.actions.push({ ...action, at: Math.floor(Date.now() / 1000) });
    if (action.kind === 'dismiss') report.status = 'dismissed';
    else report.status = 'actioned';
    if (!report.appeal_token) report.appeal_token = generateReportId();

    await this.redis
      .multi()
      .set(REPORT_PREFIX + id, JSON.stringify(report))
      .zrem(PENDING_REPORTS, id)
      .zadd(ACTIONED_REPORTS, Math.floor(Date.now() / 1000), id)
      .exec();

    return report;
  }

  async stats(): Promise<{ pending: number; actioned: number }> {
    const [pending, actioned] = await Promise.all([
      this.redis.zcard(PENDING_REPORTS),
      this.redis.zcard(ACTIONED_REPORTS),
    ]);
    return { pending, actioned };
  }
}

function generateReportId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function hashEmailForReport(email: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(email.trim().toLowerCase())),
  );
}
