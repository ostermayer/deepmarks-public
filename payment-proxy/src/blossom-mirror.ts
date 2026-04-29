import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1.js';

/**
 * Blossom mirror client — implements BUD-04 mirroring fanout.
 *
 * Used by the archive worker to replicate a newly-stored blob from our
 * primary Blossom server to the user's configured mirror list.
 *
 * BUD-04 defines a `PUT /mirror` endpoint that takes a URL to an
 * existing blob and asks the receiving server to fetch + store it.
 * This means we only upload once (to our primary), and each mirror
 * pulls from the primary — we don't re-transmit the blob N times.
 */

export interface MirrorTarget {
  /** Base URL of the Blossom server, e.g. "https://blossom.primal.net" */
  url: string;
  /** Display label for the UI and logs (e.g. "default", "user-added") */
  label?: string;
}

export interface MirrorResult {
  target: MirrorTarget;
  status: 'ok' | 'failed';
  code?: number;
  error?: string;
  duration_ms: number;
}

export interface MirrorFanoutResult {
  hash: string;
  primary_url: string;
  results: MirrorResult[];
  success_count: number;
  failure_count: number;
}

/**
 * Fan out a blob to all configured mirrors. Uses BUD-04's `PUT /mirror`
 * so each mirror fetches the blob itself from our primary — we don't
 * re-upload the bytes N times.
 *
 * Auth: each mirror request includes a BUD-01 auth event signed with
 * the owner's pubkey (proving the user is authorized to mirror their
 * own content). We build this event server-side with a dedicated
 * deepmarks-archive-worker signing key that the user has pre-authorized
 * in their account settings — OR we include the user's NIP-98 auth
 * proof if they connected a signer at archive time.
 *
 * Errors are captured per-target but don't fail the fanout; individual
 * mirror failures are reported back for retry scheduling.
 */
export async function mirrorBlob({
  hash,
  primaryUrl,
  targets,
  authEventBuilder,
}: {
  /** SHA-256 hex of the blob we want mirrored */
  hash: string;
  /** Base URL of the primary Blossom server that currently holds the blob */
  primaryUrl: string;
  /** List of mirror destinations */
  targets: MirrorTarget[];
  /** Function that builds a BUD-01 kind:24242 auth event for a given URL + action */
  authEventBuilder: (mirrorUrl: string) => Promise<NostrAuthEvent>;
}): Promise<MirrorFanoutResult> {
  const sourceUrl = `${primaryUrl.replace(/\/$/, '')}/${hash}`;

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const start = Date.now();
      try {
        const authEvent = await authEventBuilder(`${target.url}/mirror`);
        const res = await fetch(`${target.url.replace(/\/$/, '')}/mirror`, {
          method: 'PUT',
          headers: {
            'Authorization': 'Nostr ' + base64url(JSON.stringify(authEvent)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: sourceUrl }),
          // 30s timeout — mirrors that don't respond in half a minute
          // are probably overloaded; we'll retry in the background.
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          return {
            target,
            status: 'failed' as const,
            code: res.status,
            error: `mirror returned HTTP ${res.status}`,
            duration_ms: Date.now() - start,
          };
        }
        return {
          target,
          status: 'ok' as const,
          code: res.status,
          duration_ms: Date.now() - start,
        };
      } catch (err) {
        return {
          target,
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - start,
        };
      }
    }),
  );

  const flattened: MirrorResult[] = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          target: { url: 'unknown' },
          status: 'failed' as const,
          error: 'promise rejected',
          duration_ms: 0,
        },
  );

  return {
    hash,
    primary_url: primaryUrl,
    results: flattened,
    success_count: flattened.filter((r) => r.status === 'ok').length,
    failure_count: flattened.filter((r) => r.status === 'failed').length,
  };
}

/**
 * Build a BUD-01 Nostr auth event for a Blossom mirror request.
 * kind:24242 is the Blossom-auth-specific event kind.
 *
 * In production, this is signed by the deepmarks-archive-worker's key
 * (not the user's nsec). The worker's key is registered as an
 * authorized uploader for each mirror target we use.
 */
export interface NostrAuthEvent {
  kind: 24242;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
  sig: string;
}

export async function buildBlossomAuthEvent({
  workerPrivkey,
  workerPubkey,
  action,
  hash,
  expiresInSeconds = 60,
}: {
  workerPrivkey: Uint8Array;
  workerPubkey: string;
  action: 'upload' | 'get' | 'list' | 'delete';
  hash?: string;
  expiresInSeconds?: number;
}): Promise<NostrAuthEvent> {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ['t', action],
    ['expiration', (now + expiresInSeconds).toString()],
  ];
  if (hash) tags.push(['x', hash]);

  const eventBase = {
    kind: 24242 as const,
    pubkey: workerPubkey,
    created_at: now,
    tags,
    content: `mirror ${action}`,
  };

  // Serialize per NIP-01 for signing
  const serialized = JSON.stringify([
    0,
    eventBase.pubkey,
    eventBase.created_at,
    eventBase.kind,
    eventBase.tags,
    eventBase.content,
  ]);
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  const sig = bytesToHex(
    await schnorr.sign(hexToBytes(id), workerPrivkey),
  );

  return { ...eventBase, id, sig };
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Retry schedule for failed mirror targets.
 * Runs every 6 hours for 7 days, then gives up and notifies the user.
 *
 * Used by the background retry worker — not by the immediate archive
 * path, which does best-effort-once-and-move-on to keep the user's
 * purchase experience snappy.
 */
export const MIRROR_RETRY_SCHEDULE = {
  interval_seconds: 6 * 60 * 60,
  max_age_seconds: 7 * 24 * 60 * 60,
} as const;
