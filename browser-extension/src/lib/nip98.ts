// NIP-98 HTTP auth helper. Mirrors frontend/src/lib/api/client.ts's
// buildNip98AuthHeader, including the body-binding via the `payload`
// tag (sha256-hex of the request body) the deployed proxy requires
// on body-bearing routes.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { finalizeEvent } from 'nostr-tools';

export async function buildNip98AuthHeader(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  nsecHex: string,
  body?: string,
): Promise<string> {
  const tags: string[][] = [
    ['u', url],
    ['method', method],
  ];
  if (body !== undefined) {
    const bodyHashHex = bytesToHex(sha256(new TextEncoder().encode(body)));
    tags.push(['payload', bodyHashHex]);
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
    hexToBytes(nsecHex),
  );
  return `Nostr ${b64utf8(JSON.stringify(event))}`;
}

function b64utf8(s: string): string {
  // Same trick the web app uses — encode UTF-8 bytes then base64, so
  // events with non-Latin-1 characters (none in our case but defensive)
  // don't break btoa().
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
