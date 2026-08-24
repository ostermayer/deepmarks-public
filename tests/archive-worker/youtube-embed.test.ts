import { describe, expect, it, vi } from 'vitest';
import {
  isYoutubeHost,
  parseYoutubeVideoId,
  isYoutubeVideoUrl,
  buildYoutubeArchiveHtml,
} from '@src/youtube-embed.js';

describe('isYoutubeHost / parser agreement', () => {
  it('accepts every host form the parser accepts (www.youtu.be regression)', () => {
    // The media-detection gates run `isYoutubeHost(host)` BEFORE the
    // parser; any host the parser can extract an id from must pass the
    // gate, or those URLs silently drop out of media eligibility.
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(parseYoutubeVideoId(url)).toBe('dQw4w9WgXcQ');
      expect(isYoutubeHost(new URL(url).hostname)).toBe(true);
    }
    expect(isYoutubeHost('example.com')).toBe(false);
  });
});

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function jpegResponse(): Response {
  // 1x1 JPEG.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0QyY5Jjk8PTEyNDY8OERODg4/2wBDASIkJDAgJCAYEAAYEBAMDg8ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg7/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAF/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AhqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz/9k=',
    'base64',
  );
  return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

const oembedPayload = {
  title: 'How a CPU works',
  author_name: 'Navin Khambhala',
  author_url: 'https://www.youtube.com/@navinkhambhala',
  thumbnail_url: 'https://i.ytimg.com/vi/U9cazC7DBFk/hqdefault.jpg',
  type: 'video',
  provider_name: 'YouTube',
};

describe('youtube-embed', () => {
  it('parses every YouTube URL form into a video id', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?v=U9cazC7DBFk')).toBe('U9cazC7DBFk');
    expect(parseYoutubeVideoId('https://m.youtube.com/watch?v=U9cazC7DBFk&feature=emb_title')).toBe('U9cazC7DBFk');
    expect(parseYoutubeVideoId('https://youtu.be/U9cazC7DBFk')).toBe('U9cazC7DBFk');
    expect(parseYoutubeVideoId('https://www.youtube.com/embed/U9cazC7DBFk')).toBe('U9cazC7DBFk');
    expect(parseYoutubeVideoId('https://www.youtube.com/shorts/U9cazC7DBFk')).toBe('U9cazC7DBFk');
    // Non-video URLs -> null.
    expect(parseYoutubeVideoId('https://example.com/watch?v=U9cazC7DBFk')).toBeNull();
    expect(parseYoutubeVideoId('https://www.youtube.com/playlist?list=PLx')).toBeNull();
    expect(isYoutubeVideoUrl('https://example.com/post')).toBe(false);
  });

  it('builds a self-contained HTML video card from the oEmbed API', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://www.youtube.com/oembed')) return jsonResponse(oembedPayload);
      if (url.startsWith('https://i.ytimg.com/')) return jpegResponse();
      return new Response('nope', { status: 404 });
    });
    const out = await buildYoutubeArchiveHtml(
      'https://m.youtube.com/watch?v=U9cazC7DBFk&embeds_referring_euri=https%3A%2F%2Fnavinkhambhala.com%2F',
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(out).not.toBeNull();
    const html = out!.html.toString('utf-8');
    expect(out!.provider).toBe('https://www.youtube.com/oembed');
    // Title + author from oEmbed.
    expect(html).toContain('How a CPU works');
    expect(html).toContain('Navin Khambhala');
    expect(html).toContain('https://www.youtube.com/@navinkhambhala');
    // Thumbnail inlined as a data URI — the archive is self-contained.
    expect(html).toContain('data:image/jpeg;base64,');
    // Canonical link to the video.
    expect(html).toContain('href="https://www.youtube.com/watch?v=U9cazC7DBFk"');
    // Original bookmark URL preserved.
    expect(html).toContain('m.youtube.com/watch?v=U9cazC7DBFk');
    // Video id stored as a data attribute.
    expect(html).toContain('data-youtube-id="U9cazC7DBFk"');
  });

  it('renders without a thumbnail when i.ytimg.com is unreachable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://www.youtube.com/oembed')) return jsonResponse(oembedPayload);
      return new Response('nope', { status: 404 });
    });
    const out = await buildYoutubeArchiveHtml('https://youtu.be/U9cazC7DBFk', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).not.toBeNull();
    const html = out!.html.toString('utf-8');
    expect(html).toContain('How a CPU works');
    expect(html).not.toContain('data:image/');
    expect(html).toContain('https://www.youtube.com/watch?v=U9cazC7DBFk');
  });

  it('returns null when oEmbed fails (private/deleted video, API down)', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const out = await buildYoutubeArchiveHtml('https://www.youtube.com/watch?v=U9cazC7DBFk', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });

  it('returns null for non-YouTube URLs without fetching', async () => {
    const fetchMock = vi.fn();
    const out = await buildYoutubeArchiveHtml('https://example.com/post', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to inline a thumbnail whose host is not ytimg.com (SSRF guard)', async () => {
    const payload = { ...oembedPayload, thumbnail_url: 'https://evil.example.com/x.jpg' };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://www.youtube.com/oembed')) return jsonResponse(payload);
      return new Response('nope', { status: 404 });
    });
    const out = await buildYoutubeArchiveHtml('https://www.youtube.com/watch?v=U9cazC7DBFk', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out).not.toBeNull();
    const html = out!.html.toString('utf-8');
    expect(html).not.toContain('data:image/');
    expect(html).not.toContain('evil.example.com');
  });
});