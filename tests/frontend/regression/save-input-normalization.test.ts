// Regression guards for audit finding NOTE-F3 (2026-06 review), FIXED:
// pasting a `note1…` / `nevent1…` / `nostr:…` reference into the save
// box failed with a generic "Invalid URL" — the most natural "bookmark
// this note" gesture from Damus/Amethyst/Primal didn't work at all.
// normalizeBookmarkSaveInput now converts those references to the
// canonical https social URL before validation.

import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { normalizeBookmarkSaveInput, nostrNoteArchiveUrl } from '$lib/nostr/social-refs';

const NOTE_ID = 'ab'.repeat(32);
const noteRef = nip19.noteEncode(NOTE_ID);
const neventRef = nip19.neventEncode({ id: NOTE_ID, relays: ['wss://relay.damus.io'] });
const expectedUrl = nostrNoteArchiveUrl(NOTE_ID)!;

describe('normalizeBookmarkSaveInput', () => {
  it('converts a bare note1 reference to the canonical social URL', () => {
    expect(normalizeBookmarkSaveInput(noteRef)).toBe(expectedUrl);
  });

  it('converts an nevent1 reference (relay hints included)', () => {
    expect(normalizeBookmarkSaveInput(neventRef)).toBe(expectedUrl);
  });

  it('strips a nostr: URI prefix', () => {
    expect(normalizeBookmarkSaveInput(`nostr:${noteRef}`)).toBe(expectedUrl);
  });

  it('trims surrounding whitespace before detection', () => {
    expect(normalizeBookmarkSaveInput(`  ${noteRef}\n`)).toBe(expectedUrl);
  });

  it('passes ordinary URLs through untouched', () => {
    expect(normalizeBookmarkSaveInput('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('passes garbage through so URL validation owns the error message', () => {
    expect(normalizeBookmarkSaveInput('not-a-key')).toBe('not-a-key');
    expect(normalizeBookmarkSaveInput('note1qqqq')).toBe('note1qqqq'); // bad checksum
  });

  it('does not touch npub/nprofile references (they are not notes)', () => {
    const npub = nip19.npubEncode('cd'.repeat(32));
    expect(normalizeBookmarkSaveInput(npub)).toBe(npub);
  });
});
