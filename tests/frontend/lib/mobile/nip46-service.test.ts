import { describe, expect, it } from 'vitest';
import { mergeNip46PermissionLists, parseNostrConnectUri } from '$lib/mobile/nip46-service.js';

const CLIENT_PUBKEY = 'a'.repeat(64);

describe('parseNostrConnectUri', () => {
  it('parses direct Nostr Connect fields', () => {
    const parsed = parseNostrConnectUri(
      `nostrconnect://${CLIENT_PUBKEY}?relay=wss%3A%2F%2Frelay.deepmarks.org&secret=s1&name=Example&perms=sign_event%2Cnip44_encrypt`,
    );

    expect(parsed.clientPubkey).toBe(CLIENT_PUBKEY);
    expect(parsed.relays).toEqual(['wss://relay.deepmarks.org']);
    expect(parsed.secret).toBe('s1');
    expect(parsed.name).toBe('Example');
    expect(parsed.perms).toEqual(['sign_event', 'nip44_encrypt']);
  });

  it('accepts Amber-style metadata fallback fields', () => {
    const metadata = encodeURIComponent(JSON.stringify({
      name: 'Amber Client',
      url: 'https://example.com',
      image: 'https://example.com/icon.png',
      perms: 'sign_event:1,nip04_decrypt',
    }));
    const parsed = parseNostrConnectUri(
      `nostrconnect://${CLIENT_PUBKEY}?relay=wss%3A%2F%2Frelay.deepmarks.org&secret=s2&metadata=${metadata}`,
    );

    expect(parsed.name).toBe('Amber Client');
    expect(parsed.url).toBe('https://example.com');
    expect(parsed.image).toBe('https://example.com/icon.png');
    expect(parsed.perms).toEqual(['sign_event:1', 'nip04_decrypt']);
  });

  it('keeps direct fields ahead of metadata fallbacks', () => {
    const metadata = encodeURIComponent(JSON.stringify({ name: 'Metadata Client', perms: 'nip04_decrypt' }));
    const parsed = parseNostrConnectUri(
      `nostrconnect://${CLIENT_PUBKEY}?relay=wss%3A%2F%2Frelay.deepmarks.org&secret=s3&name=Direct&perms=sign_event&metadata=${metadata}`,
    );

    expect(parsed.name).toBe('Direct');
    expect(parsed.perms).toEqual(['sign_event']);
  });

  it('rejects bunker URIs because they belong to remote-signer login', () => {
    expect(() => parseNostrConnectUri(`bunker://${CLIENT_PUBKEY}?relay=wss%3A%2F%2Frelay.deepmarks.org&secret=s4`))
      .toThrow(/nostrconnect/i);
  });

  it('merges permissions requested later by a connect request', () => {
    expect(mergeNip46PermissionLists(
      ['sign_event:1', 'nip44_decrypt'],
      [' sign_event:1 ', 'sign_event:0', 'nip44_encrypt'],
    )).toEqual(['sign_event:1', 'nip44_decrypt', 'sign_event:0', 'nip44_encrypt']);
  });
});
