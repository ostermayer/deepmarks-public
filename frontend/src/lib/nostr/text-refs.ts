import { nip19 } from 'nostr-tools';

export type NostrTextPart =
  | { type: 'text'; text: string }
  | { type: 'url'; text: string; href: string }
  | { type: 'profile'; text: string; bech32: string; pubkey: string; href: string }
  | { type: 'event'; text: string; bech32: string; eventId: string; href: string; label: string }
  | { type: 'address'; text: string; bech32: string; href: string; label: string };

const TOKEN_RE = /(https?:\/\/[^\s<>"'`]+)|(?:nostr:)?((?:npub|nprofile|note|nevent|naddr)1[0-9a-z]+)/gi;

export function parseNostrText(text: string): NostrTextPart[] {
  if (!text) return [];
  const parts: NostrTextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0] ?? '';
    const start = match.index ?? 0;
    const end = start + raw.length;
    if (start > cursor) pushText(parts, text.slice(cursor, start));

    const url = match[1];
    if (url) {
      const { body, trailing } = splitTrailingPunctuation(url);
      if (body) parts.push({ type: 'url', text: body, href: body });
      if (trailing) pushText(parts, trailing);
      cursor = end;
      continue;
    }

    const bech32 = match[2]?.toLowerCase();
    const decoded = bech32 ? decodeNostrReference(raw, bech32) : null;
    if (decoded) {
      parts.push(decoded);
    } else {
      pushText(parts, raw);
    }
    cursor = end;
  }

  if (cursor < text.length) pushText(parts, text.slice(cursor));
  return parts;
}

export function readableNostrText(text: string): string {
  return parseNostrText(text)
    .map((part) => {
      if (part.type === 'profile') return 'Nostr profile';
      if (part.type === 'event' || part.type === 'address') return part.label;
      return part.text;
    })
    .join('');
}

function pushText(parts: NostrTextPart[], text: string): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.type === 'text') {
    last.text += text;
    return;
  }
  parts.push({ type: 'text', text });
}

function splitTrailingPunctuation(raw: string): { body: string; trailing: string } {
  let body = raw;
  let trailing = '';
  while (body && /[.,!?;:)\]}>"']$/.test(body)) {
    trailing = body.slice(-1) + trailing;
    body = body.slice(0, -1);
  }
  return { body, trailing };
}

function decodeNostrReference(raw: string, bech32: string): NostrTextPart | null {
  try {
    const decoded = nip19.decode(bech32);
    if (decoded.type === 'npub' && typeof decoded.data === 'string') {
      const pubkey = decoded.data.toLowerCase();
      return {
        type: 'profile',
        text: raw,
        bech32,
        pubkey,
        href: profileHref(pubkey),
      };
    }
    if (decoded.type === 'nprofile' && decoded.data && typeof decoded.data.pubkey === 'string') {
      const pubkey = decoded.data.pubkey.toLowerCase();
      return {
        type: 'profile',
        text: raw,
        bech32,
        pubkey,
        href: profileHref(pubkey),
      };
    }
    if (decoded.type === 'note' && typeof decoded.data === 'string') {
      const eventId = decoded.data.toLowerCase();
      return {
        type: 'event',
        text: raw,
        bech32,
        eventId,
        href: eventHref(eventId, bech32),
        label: 'Nostr post',
      };
    }
    if (decoded.type === 'nevent' && decoded.data && typeof decoded.data.id === 'string') {
      const eventId = decoded.data.id.toLowerCase();
      return {
        type: 'event',
        text: raw,
        bech32,
        eventId,
        href: eventHref(eventId, bech32),
        label: 'Nostr post',
      };
    }
    if (decoded.type === 'naddr') {
      return {
        type: 'address',
        text: raw,
        bech32,
        href: `https://njump.me/${bech32}`,
        label: decoded.data.kind === 30023 ? 'Nostr article' : 'Nostr event',
      };
    }
  } catch {
    return null;
  }
  return null;
}

function profileHref(pubkey: string): string {
  try {
    return `/u/${nip19.npubEncode(pubkey)}`;
  } catch {
    return `/u/${pubkey}`;
  }
}

function eventHref(eventId: string, fallbackBech32: string): string {
  try {
    return `https://primal.net/e/${nip19.noteEncode(eventId)}`;
  } catch {
    return `https://njump.me/${fallbackBech32}`;
  }
}
