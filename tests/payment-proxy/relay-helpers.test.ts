import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import { parseRelayMessage } from '@src/relay-helpers.js';

describe('parseRelayMessage', () => {
  it('ignores malformed relay frames and returns valid events', () => {
    const subId = 'sub-1';
    const event: NostrEvent = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 39701,
      tags: [],
      content: '',
      sig: 'c'.repeat(128),
    };

    expect(parseRelayMessage(Buffer.from([0, 1, 2, 3]), subId)).toBeNull();
    expect(parseRelayMessage(Buffer.from('{not json'), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', 'other', event]), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', subId, { kind: 39701 }]), subId)).toBeNull();
    expect(parseRelayMessage(JSON.stringify(['EVENT', subId, event]), subId)).toEqual({
      type: 'event',
      event,
    });
    expect(parseRelayMessage(JSON.stringify(['EOSE', subId]), subId)).toEqual({ type: 'done' });
    expect(parseRelayMessage(JSON.stringify(['CLOSED', subId, 'blocked']), subId)).toEqual({ type: 'done' });
  });
});
