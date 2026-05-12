import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { extractNostrEventIdFromUrl, isNostrSocialUrl } from './social-refs.js';

const EVENT_ID = 'a'.repeat(64);

describe('Nostr social URL detection', () => {
  it('extracts note1 ids from common social URLs', () => {
    const note = nip19.noteEncode(EVENT_ID);

    expect(extractNostrEventIdFromUrl(`https://primal.net/e/${note}`)).toBe(EVENT_ID);
    expect(extractNostrEventIdFromUrl(`https://damus.io/${note}`)).toBe(EVENT_ID);
  });

  it('extracts nevent ids from URLs', () => {
    const nevent = nip19.neventEncode({ id: EVENT_ID, relays: ['wss://relay.deepmarks.org'] });

    expect(extractNostrEventIdFromUrl(`https://njump.me/${nevent}`)).toBe(EVENT_ID);
  });

  it('extracts bare hex ids only from known Nostr social hosts', () => {
    expect(extractNostrEventIdFromUrl(`https://primal.net/e/${EVENT_ID}`)).toBe(EVENT_ID);
    expect(extractNostrEventIdFromUrl(`https://example.com/${EVENT_ID}`)).toBeNull();
  });

  it('identifies known social hosts even when no note id is parseable', () => {
    expect(isNostrSocialUrl('https://damus.io/p/npub1example')).toBe(true);
    expect(isNostrSocialUrl('https://example.com/post')).toBe(false);
  });
});
