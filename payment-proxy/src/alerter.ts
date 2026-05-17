// Operational alerting — sends an email to the operator when something
// crosses a threshold worth their attention.
//
// Design:
//   - Severity has three levels: 'critical' (page now), 'warning' (look
//     soon), 'info' (FYI; almost never used in alert paths).
//   - Per-signature debouncing: each (severity, key) pair fires at most
//     once every DEBOUNCE_SECONDS. Redis-backed SET-NX so multiple
//     processes / replicas converge on the same dedup window. Without
//     this, a flapping bunker connection or a 500-loop can email the
//     operator hundreds of times per minute.
//   - The Resend (or fallback console) sender is reused — same plumbing
//     as abuse-report email.
//   - All sends are best-effort. A failed alert send logs an ERROR but
//     never crashes the calling code path. Alerting that throws is
//     worse than alerting that silently fails.

import type { Redis } from 'ioredis';
import type { EmailSender } from './email.js';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface AlertOpts {
  severity: AlertSeverity;
  /** Stable key per alert kind. Same value across firings means the
   *  debouncer collapses them. e.g. 'bunker-disconnect:brand'. */
  key: string;
  subject: string;
  body: string;
}

export interface Alerter {
  alert(opts: AlertOpts): Promise<void>;
}

export interface AlerterConfig {
  email: EmailSender;
  redis: Redis;
  /** Where alerts go. Operator inbox, paging service inbox, etc. */
  to: string;
  /** Where the email is sent from. Must be on a Resend-verified domain. */
  fromOrigin?: string;
  /** Max one alert per (severity, key) per this window. Default 10 min.
   *  Counts on Redis, so the window is shared across replicas. */
  debounceSeconds?: number;
  /** Bound on how many alert sends total per hour, regardless of key —
   *  emergency brake against a runaway alert storm. Keys still debounced
   *  individually; this is the global ceiling. */
  hourlyCeiling?: number;
  logger?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

const DEFAULT_DEBOUNCE_SECONDS = 600;     // 10 min
const DEFAULT_HOURLY_CEILING = 50;        // 50 alerts/hour total

const DEDUP_PREFIX = 'dm:alert:dedup:';
const HOURLY_PREFIX = 'dm:alert:hourly:';

/** Construct a real Alerter that emails through `email` and dedupes
 *  through `redis`. Returns a no-op alerter when `to` is empty so
 *  dev / tests don't have to spin up Resend. */
export function makeAlerter(cfg: AlerterConfig): Alerter {
  if (!cfg.to) {
    cfg.logger?.info('[alerter] no recipient configured — alerts disabled (set ALERT_EMAIL)');
    return { async alert() { /* no-op */ } };
  }
  const debounceSeconds = cfg.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS;
  const hourlyCeiling = cfg.hourlyCeiling ?? DEFAULT_HOURLY_CEILING;
  const log = cfg.logger;

  return {
    async alert(opts: AlertOpts): Promise<void> {
      try {
        // Per-key dedup gate. Same severity+key collapses repeated
        // firings into one email per debounce window.
        const dedupKey = `${DEDUP_PREFIX}${opts.severity}:${opts.key}`;
        const claimed = await cfg.redis.set(dedupKey, '1', 'EX', debounceSeconds, 'NX');
        if (claimed !== 'OK') return;  // already alerted in this window

        // Global hourly ceiling. Increment + check; even if the per-key
        // path is fresh, refuse to emit if total alerts in the last
        // hour exceed the ceiling. INCR returns the new value; the
        // first hit in the window also stamps the TTL.
        const hourlyKey = `${HOURLY_PREFIX}${currentHour()}`;
        const count = await cfg.redis.incr(hourlyKey);
        if (count === 1) await cfg.redis.expire(hourlyKey, 3600);
        if (count > hourlyCeiling) {
          // Drop quietly — the operator will see the gap in alerts and
          // can grep logs. Returning an error here would defeat the
          // purpose (we'd be alert-storming WHILE alert-storming).
          log?.error(
            { severity: opts.severity, key: opts.key, count, ceiling: hourlyCeiling },
            'alert hourly ceiling exceeded — dropping',
          );
          return;
        }

        const subject = `[deepmarks][${opts.severity}] ${opts.subject}`;
        const text = [
          opts.body,
          '',
          '— deepmarks alerter',
          `severity: ${opts.severity}`,
          `key: ${opts.key}`,
          `time: ${new Date().toISOString()}`,
        ].join('\n');
        await cfg.email.send({ to: cfg.to, subject, text });
        log?.info({ severity: opts.severity, key: opts.key, to: cfg.to }, 'alert sent');
      } catch (err) {
        // Alerting that throws is worse than alerting that silently
        // fails — never propagate.
        log?.error({ err, key: opts.key }, 'alert send failed');
      }
    },
  };
}

function currentHour(): string {
  // YYYYMMDDHH stamp — Redis-key-safe.
  const d = new Date();
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
    String(d.getUTCHours()).padStart(2, '0'),
  ].join('');
}
