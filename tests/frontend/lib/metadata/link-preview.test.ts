import { describe, expect, it } from 'vitest';
import {
  describeLinkPreview,
  isLikelyBlossomBlobUrl,
  parseYoutubeVideoId,
  readableHost,
  youtubeEmbedUrl,
} from '$lib/metadata/link-preview.js';

describe('link preview classification', () => {
  it('detects YouTube links without fetching the page first', () => {
    const parsed = new URL('https://www.youtube.com/live/EBttg4yUE2s?si=abc');

    expect(parseYoutubeVideoId(parsed)).toBe('EBttg4yUE2s');
    expect(describeLinkPreview(parsed.toString())).toMatchObject({
      kind: 'youtube',
      host: 'youtube.com',
      youtubeId: 'EBttg4yUE2s',
      thumbnailUrl: 'https://i.ytimg.com/vi/EBttg4yUE2s/hqdefault.jpg',
      shouldFetchMetadata: true,
    });
    expect(youtubeEmbedUrl('EBttg4yUE2s')).toContain('youtube-nocookie.com/embed/EBttg4yUE2s');
  });

  it('shows direct media without server metadata fetches', () => {
    expect(describeLinkPreview('https://blossom.primal.net/hash.mp4')).toMatchObject({
      kind: 'video',
      host: 'blossom.primal.net',
      shouldFetchMetadata: false,
    });
    expect(describeLinkPreview('https://podcasts.example.org/episode.mp3')).toMatchObject({
      kind: 'audio',
      host: 'podcasts.example.org',
      shouldFetchMetadata: false,
    });
    expect(describeLinkPreview('https://image.nostr.build/pic.webp')).toMatchObject({
      kind: 'image',
      host: 'image.nostr.build',
      thumbnailUrl: 'https://image.nostr.build/pic.webp',
      shouldFetchMetadata: false,
    });
  });

  it('shortens hash-subdomain blossom hosts for readable rows', () => {
    const url = new URL(
      'https://npub13kwjkaunpmj5aslyd7hhwnwaqswmknj25dddlqztzz29pkavhaq25wg2a.blossom.band/file.jpg',
    );

    expect(readableHost(url)).toBe('blossom.band');
  });

  it('flags extensionless Blossom blob URLs for metadata sniffing', () => {
    expect(isLikelyBlossomBlobUrl(
      'https://blossom.primal.net/5605dcac7b8fde7e003959fb221791f6dff0dc424e581894d6c4443a8f18b502',
    )).toBe(true);
    expect(isLikelyBlossomBlobUrl('https://example.com/5605dcac7b8fde7e003959fb221791f6')).toBe(false);
    expect(isLikelyBlossomBlobUrl('nostr:note1abc')).toBe(false);
  });
});
