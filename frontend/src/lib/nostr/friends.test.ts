import { describe, expect, it } from 'vitest';
import { FRIENDS_SET_NAME, parseFriendsSetEvent } from './friends';

describe('parseFriendsSetEvent', () => {
  it('extracts valid p-tags for the Deepmarks friends set', () => {
    const alice = 'a'.repeat(64);
    const bob = 'B'.repeat(64);
    const parsed = parseFriendsSetEvent([
      ['d', FRIENDS_SET_NAME],
      ['title', 'Deepmarks friends'],
      ['p', alice],
      ['p', bob],
      ['p', 'not-a-pubkey'],
      ['t', 'ignored'],
    ]);

    expect([...parsed.pubkeys]).toEqual([alice, bob.toLowerCase()]);
    expect(parsed.loaded).toBe(true);
  });
});
