import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { schnorr } from '@noble/curves/secp256k1';

/**
 * Blossom upload + mirror client for the archive worker.
 *
 * Signs BUD-01 auth events with the archive worker's dedicated
 * Nostr key. That pubkey must be in the blossom-server's
 * WRITE_ALLOWLIST_PUBKEYS env var on Box A.
 */

export interface BlossomUploadResult {
  blobHash: string;
  primaryUrl: string;
  size: number;
}

export class BlossomClient {
  constructor(
    private readonly primaryUrl: string,
    private readonly workerPrivkey: Uint8Array,
    private readonly workerPubkey: string,
  ) {
    if (workerPrivkey.length !== 32) {
      throw new Error('worker privkey must be 32 bytes');
    }
  }

  /**
   * Upload a blob to the primary Blossom server. Returns the SHA-256
   * hash (hex) and upload metadata.
   *
   * BUD-01 auth: PUT /upload with an `Authorization: Nostr <b64event>`
   * header, where the event is kind:24242 with appropriate tags.
   */
  async upload(blob: Buffer, contentType = 'text/html'): Promise<BlossomUploadResult> {
    const blobHash = bytesToHex(sha256(blob));
    const authEvent = await this.buildAuth('upload', blobHash, this.primaryUrl);

    const res = await fetch(`${this.primaryUrl.replace(/\/$/, '')}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: `Nostr ${base64Encode(JSON.stringify(authEvent))}`,
        'Content-Type': contentType,
      },
      // Node's Buffer / Uint8Array<ArrayBufferLike> vs DOM's BodyInit don't
      // unify in the type system even though the runtime accepts them. Cast
      // through unknown to the DOM type rather than disabling strict typing.
      body: toBodyBytes(blob) as unknown as BodyInit,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`blossom upload failed: ${res.status} ${errText}`);
    }

    return { blobHash, primaryUrl: this.primaryUrl, size: blob.byteLength };
  }

  /**
   * Confirm an uploaded blob is actually retrievable from the primary
   * server. Used as a post-upload verification step in the worker —
   * a 200 OK on PUT /upload doesn't guarantee the bytes are durable
   * yet on every Blossom implementation, and a silent storage failure
   * here would leave us with a `done` record pointing at a hash that
   * Blossom can't serve. Cheap HEAD check; ~50ms in the happy path.
   *
   * Returns true on 200 OK, false otherwise. Caller treats false as
   * a retryable failure — the next attempt will re-upload and re-verify.
   */
  async verify(blobHash: string): Promise<{ ok: boolean; status: number; size: number | null }> {
    const url = `${this.primaryUrl.replace(/\/$/, '')}/${blobHash}`;
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(15_000),
      });
      const sizeHeader = res.headers.get('content-length');
      const size = sizeHeader ? parseInt(sizeHeader, 10) : null;
      return { ok: res.ok, status: res.status, size: Number.isFinite(size) ? size : null };
    } catch {
      return { ok: false, status: 0, size: null };
    }
  }

  /**
   * Fan out to mirrors via BUD-04 PUT /mirror. Each mirror fetches
   * the blob from our primary itself — we don't re-upload bytes.
   *
   * Returns per-mirror results so the caller can schedule retries
   * for any failures.
   */
  async mirror(
    blobHash: string,
    mirrorUrls: string[],
  ): Promise<Array<{ url: string; ok: boolean; error?: string }>> {
    const sourceUrl = `${this.primaryUrl.replace(/\/$/, '')}/${blobHash}`;
    const results = await Promise.all(
      mirrorUrls.map(async (mirrorUrl) => {
        try {
          // Per-mirror auth event: include the destination URL in a
          // `server` tag so the auth can't be intercepted and replayed
          // against a different mirror within the 60s freshness window.
          // Servers that don't honor BUD-01's URL binding ignore the
          // tag — no compatibility risk.
          const authEvent = await this.buildAuth('upload', blobHash, mirrorUrl);
          const res = await fetch(`${mirrorUrl.replace(/\/$/, '')}/mirror`, {
            method: 'PUT',
            headers: {
              Authorization: `Nostr ${base64Encode(JSON.stringify(authEvent))}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: sourceUrl }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            return { url: mirrorUrl, ok: false, error: `HTTP ${res.status}` };
          }
          return { url: mirrorUrl, ok: true };
        } catch (err) {
          return {
            url: mirrorUrl,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return results;
  }

  /**
   * Build a BUD-01 kind:24242 auth event for a given action and blob.
   * 60-second expiration — enough for network latency, short enough
   * that a leaked event can't be replayed meaningfully. The optional
   * `serverUrl` adds a BUD-01 `server` tag binding the auth to a
   * specific destination so a captured event can't be replayed
   * against a different Blossom server within the freshness window.
   */
  private async buildAuth(
    action: 'upload' | 'get' | 'list' | 'delete',
    blobHash: string,
    serverUrl?: string,
  ): Promise<NostrAuthEvent> {
    const now = Math.floor(Date.now() / 1000);
    const tags: string[][] = [
      ['t', action],
      ['x', blobHash],
      ['expiration', (now + 60).toString()],
    ];
    if (serverUrl) {
      // Normalize trailing slash so the same logical URL hashes to the
      // same auth event regardless of how the caller passed it.
      tags.push(['server', serverUrl.replace(/\/$/, '')]);
    }

    const base = {
      kind: 24242 as const,
      pubkey: this.workerPubkey,
      created_at: now,
      tags,
      content: `archive ${action}`,
    };

    // NIP-01 serialization for signing
    const serialized = JSON.stringify([
      0,
      base.pubkey,
      base.created_at,
      base.kind,
      base.tags,
      base.content,
    ]);
    const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
    const sig = bytesToHex(await schnorr.sign(hexToBytes(id), this.workerPrivkey));

    return { ...base, id, sig };
  }
}

export interface NostrAuthEvent {
  kind: 24242;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
  sig: string;
}

function base64Encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * Copy a Node Buffer's bytes into a fresh ArrayBuffer-backed Uint8Array.
 * Shields the caller from the ArrayBufferLike vs ArrayBuffer divergence
 * between Node's Buffer types and the DOM fetch types.
 */
function toBodyBytes(buf: Buffer): Uint8Array {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
