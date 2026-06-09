import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { parseNostrText, readableNostrText } from '$lib/nostr/text-refs.js';

const PUBKEY = '1'.repeat(64);
const EVENT_ID = '2'.repeat(64);

describe('Nostr text references', () => {
  it('turns profile refs into profile parts', () => {
    const npub = nip19.npubEncode(PUBKEY);
    const parts = parseNostrText(`hello nostr:${npub}`);

    expect(parts).toEqual([
      { type: 'text', text: 'hello ' },
      {
        type: 'profile',
        text: `nostr:${npub}`,
        bech32: npub,
        pubkey: PUBKEY,
        href: `/u/${npub}`,
      },
    ]);
  });

  it('turns note refs into post links without keeping raw protocol text as the label', () => {
    const note = nip19.noteEncode(EVENT_ID);
    const parts = parseNostrText(`read ${note}.`);

    expect(parts).toMatchObject([
      { type: 'text', text: 'read ' },
      {
        type: 'event',
        text: note,
        eventId: EVENT_ID,
        label: 'Nostr post',
      },
      { type: 'text', text: '.' },
    ]);
  });

  it('can produce plain readable labels for titles', () => {
    const npub = nip19.npubEncode(PUBKEY);
    const note = nip19.noteEncode(EVENT_ID);

    expect(readableNostrText(`with nostr:${npub} and ${note}`)).toBe(
      'with Nostr profile and Nostr post',
    );
  });
});
