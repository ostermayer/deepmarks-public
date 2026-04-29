import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const fetchEvent = vi.fn();
vi.mock('./ndk.js', () => ({
  getNdk: () => ({ fetchEvent })
}));

import {
  parseProfileContent,
  isLikelyImageUrl,
  getProfile,
  __resetProfileCacheForTests
} from './profiles.js';

beforeEach(() => {
  fetchEvent.mockReset();
  __resetProfileCacheForTests();
});

describe('isLikelyImageUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isLikelyImageUrl('https://example.com/x.jpg')).toBe(true);
    expect(isLikelyImageUrl('http://example.com/x.png')).toBe(true);
  });
  it('rejects javascript: and data: schemes (XSS / oversize concerns)', () => {
    expect(isLikelyImageUrl('javascript:alert(1)')).toBe(false);
    expect(isLikelyImageUrl('data:image/png;base64,iVBOR…')).toBe(false);
  });
  it('rejects malformed strings without throwing', () => {
    expect(isLikelyImageUrl('not a url')).toBe(false);
    expect(isLikelyImageUrl(undefined)).toBe(false);
    expect(isLikelyImageUrl('')).toBe(false);
  });
});

describe('parseProfileContent', () => {
  it('extracts the standard NIP-01 profile fields', () => {
    const json = JSON.stringify({
      name: 'alice',
      display_name: 'Alice Smith',
      picture: 'https://example.com/me.jpg',
      about: 'hi',
      lud16: 'alice@getalby.com',
      nip05: 'alice@example.com',
      website: 'https://example.com'
    });
    const p = parseProfileContent(json, 'pub-1');
    expect(p).toEqual({
      pubkey: 'pub-1',
      name: 'alice',
      displayName: 'alice',
      picture: 'https://example.com/me.jpg',
      about: 'hi',
      lud16: 'alice@getalby.com',
      nip05: 'alice@example.com',
      website: 'https://example.com'
    });
  });

  it('prefers name over display_name so the Nostr handle wins', () => {
    const p = parseProfileContent(
      JSON.stringify({ name: 'alice', display_name: 'Alice Smith' }),
      'pub-1',
    );
    expect(p?.displayName).toBe('alice');
  });

  it('falls back to display_name when name is absent', () => {
    const p = parseProfileContent(
      JSON.stringify({ display_name: 'Alice Smith' }),
      'pub-1',
    );
    expect(p?.displayName).toBe('Alice Smith');
  });

  it('also accepts the camelCase displayName variant some clients emit', () => {
    const p = parseProfileContent(JSON.stringify({ displayName: 'AliceCamel' }), 'pub-1');
    expect(p?.displayName).toBe('AliceCamel');
  });

  it('strips an unsafe picture URL but keeps the rest of the profile', () => {
    const p = parseProfileContent(
      JSON.stringify({ name: 'a', picture: 'javascript:alert(1)' }),
      'pub-1'
    );
    expect(p?.picture).toBeUndefined();
    expect(p?.name).toBe('a');
  });

  it('treats whitespace-only fields as absent', () => {
    const p = parseProfileContent(JSON.stringify({ name: '   ', about: '\t' }), 'pub-1');
    expect(p?.name).toBeUndefined();
    expect(p?.about).toBeUndefined();
  });

  it('returns null on invalid JSON without throwing', () => {
    expect(parseProfileContent('not json', 'pub-1')).toBeNull();
  });

  it('returns null on non-object JSON (array, string, number)', () => {
    expect(parseProfileContent('[]', 'pub-1')).toBeNull();
    expect(parseProfileContent('"alice"', 'pub-1')).toBeNull();
    expect(parseProfileContent('42', 'pub-1')).toBeNull();
  });

  it('accepts an empty object — pubkey is set, everything else undefined', () => {
    const p = parseProfileContent('{}', 'pub-1');
    expect(p?.pubkey).toBe('pub-1');
    expect(p?.picture).toBeUndefined();
    expect(p?.name).toBeUndefined();
  });

  it('also accepts lightning_address as an alias for lud16', () => {
    const p = parseProfileContent(
      JSON.stringify({ lightning_address: 'a@b.com' }),
      'pub-1'
    );
    expect(p?.lud16).toBe('a@b.com');
  });
});

describe('getProfile (reactive store)', () => {
  it('starts at null, then resolves to the parsed profile', async () => {
    fetchEvent.mockResolvedValue({
      content: JSON.stringify({ name: 'alice', display_name: 'Alice' }),
    });
    const store = getProfile('pub-1');
    expect(get(store)).toBeNull();
    // Microtask flush
    await new Promise((r) => setTimeout(r, 0));
    expect(get(store)?.displayName).toBe('alice');
  });

  it('caches by pubkey — repeated calls share a single fetch', async () => {
    fetchEvent.mockResolvedValue({ content: '{}' });
    getProfile('pub-1');
    getProfile('pub-1');
    getProfile('pub-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps store at null when fetchEvent resolves to null (no kind:0 yet)', async () => {
    fetchEvent.mockResolvedValue(null);
    const store = getProfile('pub-2');
    await new Promise((r) => setTimeout(r, 0));
    expect(get(store)).toBeNull();
  });

  it('keeps store at null when fetch throws — no UI crash', async () => {
    fetchEvent.mockRejectedValue(new Error('relay down'));
    const store = getProfile('pub-3');
    await new Promise((r) => setTimeout(r, 0));
    expect(get(store)).toBeNull();
  });
});
