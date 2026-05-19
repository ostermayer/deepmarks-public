import { nip19 } from 'nostr-tools';

const BECH32_EVENT_RE = /\b(?:nostr:)?((?:note|nevent)1[0-9a-z]+)\b/gi;
const HEX_RE = /(?:^|[^0-9a-f])([0-9a-f]{64})(?:$|[^0-9a-f])/i;

const NOSTR_SOCIAL_HOSTS = new Set([
  'coracle.social',
  'damus.io',
  'habla.news',
  'highlighter.com',
  'iris.to',
  'jumble.social',
  'njump.me',
  'nos.social',
  'nostr.band',
  'nostr.com',
  'nostrudel.ninja',
  'nostter.app',
  'primal.net',
  'satellite.earth',
  'snort.social',
  'yakihonne.com',
  'zap.stream',
]);

function cleanHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isKnownNostrSocialHost(hostname: string): boolean {
  const host = cleanHost(hostname);
  if (NOSTR_SOCIAL_HOSTS.has(host)) return true;
  return [...NOSTR_SOCIAL_HOSTS].some((known) => host.endsWith(`.${known}`));
}

function decodeEventId(bech32: string): string | null {
  try {
    const decoded = nip19.decode(bech32.toLowerCase());
    if (decoded.type === 'note' && typeof decoded.data === 'string') {
      return decoded.data.toLowerCase();
    }
    if (decoded.type === 'nevent' && typeof decoded.data.id === 'string') {
      return decoded.data.id.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

function searchableText(input: string): { text: string; knownHost: boolean } {
  if (input.startsWith('nostr:')) {
    return { text: input, knownHost: true };
  }
  try {
    const url = new URL(input);
    const text = [
      url.pathname,
      url.search,
      url.hash,
    ].map((part) => {
      try { return decodeURIComponent(part); }
      catch { return part; }
    }).join(' ');
    return { text, knownHost: isKnownNostrSocialHost(url.hostname) };
  } catch {
    return { text: input, knownHost: false };
  }
}

/** Extract a bookmarked Nostr note/event id from common social URLs. */
export function extractNostrEventIdFromUrl(input: string): string | null {
  const { text, knownHost } = searchableText(input.trim());

  for (const match of text.matchAll(BECH32_EVENT_RE)) {
    const id = decodeEventId(match[1] ?? '');
    if (id) return id;
  }

  if (knownHost) {
    const hex = HEX_RE.exec(text)?.[1];
    if (hex) return hex.toLowerCase();
  }

  return null;
}

/** True when a URL is a Nostr-social page, even if the note id is not parseable. */
export function isNostrSocialUrl(input: string): boolean {
  if (extractNostrEventIdFromUrl(input)) return true;
  try {
    return isKnownNostrSocialHost(new URL(input).hostname);
  } catch {
    return input.trim().startsWith('nostr:');
  }
}
