import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryResolvePodcastEpisodeArchive } from './podcast.js';

vi.mock('./safe-url.js', () => ({
  assertSafePublicHttpUrl: vi.fn(async (raw: string) => new URL(raw)),
}));

describe('podcast episode archive discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves an episode page to its RSS enclosure audio', async () => {
    const page = `<!doctype html><link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    const feed = `<?xml version="1.0"?>
      <rss><channel><item>
        <title>Episode 42</title>
        <link>https://pod.example/episodes/42</link>
        <enclosure url="https://cdn.pod.example/42.mp3" type="audio/mpeg" length="12" />
      </item></channel></rss>`;
    const audio = Buffer.from('ID3 episode');
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url === 'https://pod.example/episodes/42') return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://pod.example/feed.xml') return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      if (url === 'https://cdn.pod.example/42.mp3') {
        return new Response(audio, {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(audio.byteLength),
          },
        });
      }
      return new Response(null, { status: 404 });
    }));

    const archive = await tryResolvePodcastEpisodeArchive('https://pod.example/episodes/42');

    expect(archive?.sourceUrl).toBe('https://cdn.pod.example/42.mp3');
    expect(archive?.title).toBe('Episode 42');
    expect(archive?.contentType).toBe('audio/mpeg');
    expect(archive?.bytes.toString('ascii')).toContain('episode');
  });

  it('resolves Atom enclosure links for podcast episode pages', async () => {
    const page = `<!doctype html><link rel="alternate" type="application/atom+xml" href="/atom.xml">`;
    const feed = `<?xml version="1.0"?>
      <feed>
        <entry>
          <title>Atom Episode</title>
          <link rel="alternate" href="https://pod.example/episodes/atom" />
          <link rel="enclosure" href="https://cdn.pod.example/atom.m4a" type="audio/mp4" />
        </entry>
      </feed>`;
    const audio = Buffer.from('m4a episode');
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url === 'https://pod.example/episodes/atom') return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://pod.example/atom.xml') return new Response(feed, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      if (url === 'https://cdn.pod.example/atom.m4a') {
        return new Response(audio, {
          status: 200,
          headers: {
            'content-type': 'audio/mp4',
            'content-length': String(audio.byteLength),
          },
        });
      }
      return new Response(null, { status: 404 });
    }));

    const archive = await tryResolvePodcastEpisodeArchive('https://pod.example/episodes/atom');

    expect(archive?.sourceUrl).toBe('https://cdn.pod.example/atom.m4a');
    expect(archive?.title).toBe('Atom Episode');
    expect(archive?.contentType).toBe('audio/mp4');
    expect(archive?.bytes.toString('ascii')).toContain('episode');
  });

  it('does not archive the first episode from a multi-item feed when the page does not match', async () => {
    const page = `<!doctype html><link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    const feed = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Episode 1</title>
          <link>https://pod.example/episodes/1</link>
          <enclosure url="https://cdn.pod.example/1.mp3" type="audio/mpeg" />
        </item>
        <item>
          <title>Episode 2</title>
          <link>https://pod.example/episodes/2</link>
          <enclosure url="https://cdn.pod.example/2.mp3" type="audio/mpeg" />
        </item>
      </channel></rss>`;
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url === 'https://pod.example/episodes/missing') return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://pod.example/feed.xml') return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
      return new Response(Buffer.from('wrong episode'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const archive = await tryResolvePodcastEpisodeArchive('https://pod.example/episodes/missing');

    expect(archive).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('https://cdn.pod.example/1.mp3');
  });
});
