import { nip19 } from 'nostr-tools';
import { normalizeRelayUrl } from './relay-helpers.js';

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
          ? decoded.data.relays.flatMap((relay) => {
              const normalized = normalizeRelayUrl(relay);
              return normalized ? [normalized] : [];
            })
          : [],
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isKnownNostrSocialHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (NOSTR_SOCIAL_HOSTS.has(host)) return true;
  return [...NOSTR_SOCIAL_HOSTS].some((known) => host.endsWith(`.${known}`));
}

/** Canonical archive URL for a bookmarked Nostr note. njump.me
 *  server-renders the note as static HTML (title, content, media) so
 *  SingleFile captures a real archive; primal.net is a client-side SPA that
 *  loads the note over a websocket after capture, leaving an empty shell.
 *  The one copy of this policy — publish and the lifetime backfill must
 *  archive a note to the SAME URL or dedupe/archive identity splits. */
export function nostrNoteArchiveUrl(eventId: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(eventId)) return null;
  try {
    return `https://njump.me/${nip19.noteEncode(eventId.toLowerCase())}`;
  } catch {
    return `https://njump.me/${eventId.toLowerCase()}`;
  }
}
