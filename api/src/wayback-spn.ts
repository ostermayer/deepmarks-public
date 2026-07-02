import { createHash } from 'node:crypto';

// Internet Archive "Save Page Now". We ask IA to independently capture a
// public webpage so a permanent Wayback snapshot exists even when our own
// datacenter renderer is bot-walled. IA crawls from its own infrastructure
// and often succeeds where Box B is blocked; the archive rescue pass already
// consults Wayback, so a fresh snapshot feeds the machine we already built.
//
// This is OFF by default (WAYBACK_SPN_ENABLED) and strictly best-effort —
// archiving must never depend on a third party. Submit ONLY public webpage
// URLs: SPN creates a *public* archive.org snapshot, so private/encrypted
// archives and the paid media add-on must never be sent here.

const SPN_ENDPOINT = 'https://web.archive.org/save';
const DEFAULT_TIMEOUT_MS = 12_000;
// One capture request per URL per day. Collapses a retry storm (a job that
// fails MAX_ATTEMPTS times) and the enqueue+failure double-fire into a single
// submission, and keeps us inside IA's rate limits.
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

export type SpnSkipReason = 'disabled' | 'invalid-url' | 'duplicate';

export interface SpnResult {
  submitted: boolean;
  skipped?: SpnSkipReason;
  status?: number;
  jobId?: string;
  error?: string;
}

interface RedisLike {
  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null>;
}

interface Logger {
  info?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface SpnOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  /** For logs only — which hook fired this submission. */
  trigger?: 'enqueue' | 'failure';
}

/** Save Page Now is opt-in. Off until the operator sets WAYBACK_SPN_ENABLED,
 *  so wiring the call sites changes nothing in production by default. */
export function isSavePageNowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.WAYBACK_SPN_ENABLED ?? '').trim());
}

function spnDedupeKey(url: string): string {
  return `dm:spn:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
}

function isPublicHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && u.hostname.includes('.')
      && u.hostname !== 'localhost';
  } catch {
    return false;
  }
}

/** Best-effort: ask IA's Save Page Now to capture `url`. Never throws. Returns
 *  what happened so callers can log. Deduped per URL per day via Redis SET NX.
 *
 *  Callers MUST gate on tier/kind themselves — this submits whatever URL it is
 *  given to a *public* archive, so only ever pass public webpage URLs. */
export async function maybeSubmitToSavePageNow(
  redis: RedisLike,
  url: string,
  options: SpnOptions = {},
): Promise<SpnResult> {
  const env = options.env ?? process.env;
  if (!isSavePageNowEnabled(env)) return { submitted: false, skipped: 'disabled' };
  if (!isPublicHttpUrl(url)) return { submitted: false, skipped: 'invalid-url' };

  // Politeness + idempotency: claim the per-URL daily slot before submitting,
  // so concurrent retries can't double-submit. We keep the slot on any outcome
  // (even failure) — a URL IA just rejected shouldn't be re-hammered today.
  const fresh = await redis
    .set(spnDedupeKey(url), '1', 'EX', DEDUP_TTL_SECONDS, 'NX')
    .catch(() => null);
  if (!fresh) return { submitted: false, skipped: 'duplicate' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const s3Key = (env.WAYBACK_SPN_S3_KEY ?? '').trim();
  try {
    let res: Response;
    if (s3Key) {
      // Authenticated SPN2: returns immediately with a job_id (async capture)
      // and much higher rate limits. Auth header is "LOW accesskey:secret".
      res = await fetchImpl(SPN_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `LOW ${s3Key}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ url }).toString(),
        signal: controller.signal,
      });
    } else {
      // Anonymous: GET the save URL to trigger a capture (heavily
      // rate-limited — set WAYBACK_SPN_S3_KEY to raise the ceiling).
      res = await fetchImpl(`${SPN_ENDPOINT}/${url}`, {
        method: 'GET',
        headers: { 'User-Agent': 'deepmarks-archiver (+https://deepmarks.org)' },
        redirect: 'manual',
        signal: controller.signal,
      });
    }
    let jobId: string | undefined;
    if (s3Key && res.ok) {
      jobId = await res
        .json()
        .then((j) => (j as { job_id?: string }).job_id)
        .catch(() => undefined);
    }
    options.logger?.info?.(
      { url, status: res.status, jobId, authenticated: !!s3Key, trigger: options.trigger },
      'save-page-now submitted',
    );
    // 2xx/3xx all mean IA accepted the trigger; a redirect on the anonymous
    // path is a normal "capture started / already archived" outcome.
    return { submitted: res.status < 400, status: res.status, jobId };
  } catch (err) {
    options.logger?.debug?.(
      { url, trigger: options.trigger, err: String(err).slice(0, 200) },
      'save-page-now submit failed',
    );
    return { submitted: false, error: String(err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
