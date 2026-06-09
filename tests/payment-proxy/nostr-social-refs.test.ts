import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';

import { extractNostrEventRefFromUrl } from '@src/nostr-social-refs.js';

const EVENT_ID = 'a'.repeat(64);

describe('extractNostrEventRefFromUrl', () => {
  it('extracts note ids from common Nostr social URLs', () => {
    const note = nip19.noteEncode(EVENT_ID);

    expect(extractNostrEventRefFromUrl(`https://primal.net/e/${note}`)?.id).toBe(EVENT_ID);
    expect(extractNostrEventRefFromUrl(`https://damus.io/${note}`)?.id).toBe(EVENT_ID);
  });

  it('extracts relay hints from nevent URLs', () => {
    const nevent = nip19.neventEncode({
      id: EVENT_ID,
      relays: ['wss://relay.deepmarks.org/', 'not-a-relay'],
    });

    expect(extractNostrEventRefFromUrl(`https://njump.me/${nevent}`)).toEqual({
      id: EVENT_ID,
      relays: ['wss://relay.deepmarks.org'],
    });
  });

  it('extracts bare hex ids only from known Nostr hosts', () => {
    expect(extractNostrEventRefFromUrl(`https://primal.net/e/${EVENT_ID}`)?.id).toBe(EVENT_ID);
    expect(extractNostrEventRefFromUrl(`https://example.com/${EVENT_ID}`)).toBeNull();
  });

  it('extracts nostr: event refs saved directly as URLs', () => {
    const note = nip19.noteEncode(EVENT_ID);

    expect(extractNostrEventRefFromUrl(`nostr:${note}`)?.id).toBe(EVENT_ID);
  });
});
