// Blossom upload helper for the frontend.
//
// BUD-01 / BUD-02: PUT /upload with `Authorization: Nostr <b64-event>`
// where the event is a kind:24242 carrying the action (`upload`), the
// blob's sha256 (`x` tag), and a short-lived expiration. Server returns
// the canonical {url, sha256, size, ...} on success.
//
// Used today by the profile-picture editor to host avatars on
// blossom.deepmarks.org instead of asking users to host an image
// elsewhere. Could later host other small user-owned assets the same
// way (banner, NIP-05 verification doc, etc).

import { config } from './config.js';
import { getNdk } from './nostr/ndk.js';
import { NDKEvent } from '@nostr-dev-kit/ndk';

export interface BlossomBlob {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded?: number;
}

const KIND_BLOSSOM_AUTH = 24242;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Upload `blob` to the configured Blossom primary using the active
 * NDK signer to mint a BUD-01 auth event. Returns the server's
 * descriptor (canonical URL + sha256 hash).
 *
 * Throws if no signer is connected (NDKEvent#sign asks the signer for
 * a signature) — the caller should surface a "sign in again on this
 * tab" hint when this happens for nsec sessions.
 */
export async function uploadToBlossom(blob: Blob, opts: { serverUrl?: string } = {}): Promise<BlossomBlob> {
  const ndk = getNdk();
  if (!ndk.signer) {
    throw new Error("your signer isn't connected on this tab — sign in again to upload.");
  }
  const serverUrl = (opts.serverUrl ?? config.blossomUrl).replace(/\/$/, '');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = await sha256Hex(bytes);

  const now = Math.floor(Date.now() / 1000);
  const auth = new NDKEvent(ndk, {
    kind: KIND_BLOSSOM_AUTH,
    created_at: now,
    // 60s expiration: enough for network latency, narrow enough that
    // a leaked auth event can't be replayed against the same server
    // beyond the upload that's already happening.
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', String(now + 60)],
      // Bind to a specific server so a captured event can't be
      // replayed against a different Blossom instance within the
      // freshness window.
      ['server', serverUrl],
    ],
    content: 'profile picture upload',
  });
  await auth.sign();

  const authB64 = btoa(JSON.stringify(auth.rawEvent()));
  const res = await fetch(`${serverUrl}/upload`, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      Authorization: `Nostr ${authB64}`,
    },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`blossom upload failed: ${res.status} ${text}`.trim());
  }
  const descriptor = (await res.json()) as BlossomBlob;
  if (!descriptor.url) throw new Error('blossom upload returned no url');
  return descriptor;
}
