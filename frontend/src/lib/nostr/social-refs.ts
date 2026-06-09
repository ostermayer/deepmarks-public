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

export interface NostrEventRef {
  id: string;
  relays: string[];
}

function cleanHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isKnownNostrSocialHost(hostname: string): boolean {
  const host = cleanHost(hostname);
  if (NOSTR_SOCIAL_HOSTS.has(host)) return true;
  return [...NOSTR_SOCIAL_HOSTS].some((known) => host.endsWith(`.${known}`));
}

function decodeEventRef(bech32: string): NostrEventRef | null {
  try {
    const decoded = nip19.decode(bech32.toLowerCase());
    if (decoded.type === 'note' && typeof decoded.data === 'string') {
      return { id: decoded.data.toLowerCase(), relays: [] };
    }
    if (decoded.type === 'nevent' && typeof decoded.data.id === 'string') {
      return {
        id: decoded.data.id.toLowerCase(),
        relays: Array.isArray(decoded.data.relays)
          ? decoded.data.relays.filter((relay): relay is string => typeof relay === 'string')
          : [],
      };
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
export function extractNostrEventRefFromUrl(input: string): NostrEventRef | null {
  const { text, knownHost } = searchableText(input.trim());

  for (const match of text.matchAll(BECH32_EVENT_RE)) {
    const ref = decodeEventRef(match[1] ?? '');
    if (ref) return ref;
  }

  if (knownHost) {
    const hex = HEX_RE.exec(text)?.[1];
    if (hex) return { id: hex.toLowerCase(), relays: [] };
  }

  return null;
}

/** Extract a bookmarked Nostr note/event id from common social URLs. */
export function extractNostrEventIdFromUrl(input: string): string | null {
  return extractNostrEventRefFromUrl(input)?.id ?? null;
}

/** Normalize raw save-box input. A pasted `note1…` / `nevent1…` /
 *  `nostr:…` reference (the natural "copy note id" output of Damus,
 *  Amethyst, Primal…) becomes the canonical https social URL we
 *  bookmark notes under; anything else passes through untouched so the
 *  regular URL validation still owns the error message. */
export function normalizeBookmarkSaveInput(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^nostr:/i, '');
  if (!/^(?:note|nevent)1[0-9a-z]+$/i.test(stripped)) return trimmed;
  try {
    const decoded = nip19.decode(stripped.toLowerCase());
    const id =
      decoded.type === 'note'
        ? (decoded.data as string)
        : decoded.type === 'nevent'
          ? (decoded.data as { id: string }).id
          : null;
    if (id) return nostrNoteArchiveUrl(id) ?? trimmed;
  } catch {
    // Bad checksum / truncated paste — let URL validation report it.
  }
  return trimmed;
}

export function nostrNoteArchiveUrl(eventId: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(eventId)) return null;
  try {
    return `https://primal.net/e/${nip19.noteEncode(eventId.toLowerCase())}`;
  } catch {
    return `https://primal.net/e/${eventId.toLowerCase()}`;
  }
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
