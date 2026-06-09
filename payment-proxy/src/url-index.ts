import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Canonical URL form used for per-URL Redis indexes.
 *
 * This does not affect what users see or what gets signed into Nostr
 * events. It only keeps server-side lookup/count keys stable across
 * harmless variants such as fragments, tracking parameters, default
 * ports, host casing, and trailing slashes.
 */
export function canonicalizeUrlForIndex(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.toLowerCase().trim();
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  url.hash = '';

  const keptParams: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (!key.toLowerCase().startsWith('utm_')) keptParams.push([key, value]);
  }
  url.search = '';
  for (const [key, value] of keptParams) url.searchParams.append(key, value);

  return url.toString();
}

export function urlIndexHash(raw: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalizeUrlForIndex(raw))));
}
