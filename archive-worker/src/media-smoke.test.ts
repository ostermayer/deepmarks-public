import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { tryDownloadDirectFileArchive } from './direct-file.js';

const RUN = process.env.DEEPMARKS_MEDIA_SMOKE === '1';
const RUN_HOSTED = process.env.DEEPMARKS_MEDIA_SMOKE_HOSTED === '1';
const SEED = process.env.DEEPMARKS_MEDIA_SMOKE_SEED ?? new Date().toISOString().slice(0, 10);

interface DirectFixture {
  label: string;
  urls: string[];
  expectContentType: RegExp;
}

interface HostedFixture {
  label: string;
  urls: string[];
}

const DIRECT_FIXTURES: DirectFixture[] = [
  {
    label: 'direct image',
    urls: [
      'https://interactive-examples.mdn.mozilla.net/media/examples/plumeria.jpg',
      'https://interactive-examples.mdn.mozilla.net/media/cc0-images/painted-hand-298-332.jpg',
    ],
    expectContentType: /^image\/jpeg$/,
  },
  {
    label: 'direct audio',
    urls: [
      'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',
    ],
    expectContentType: /^audio\/mpeg$/,
  },
  {
    label: 'direct video',
    urls: [
      'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    ],
    expectContentType: /^video\/mp4$/,
  },
  {
    label: 'direct PDF',
    urls: [
      'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    ],
    expectContentType: /^application\/pdf$/,
  },
  {
    label: 'direct SVG',
    urls: [
      'https://upload.wikimedia.org/wikipedia/commons/0/02/SVG_logo.svg',
    ],
    expectContentType: /^image\/svg\+xml$/,
  },
  {
    label: 'direct JSON',
    urls: [
      'https://jsonplaceholder.typicode.com/todos/1',
    ],
    expectContentType: /^application\/json$/,
  },
  {
    label: 'direct CSV',
    urls: [
      'https://raw.githubusercontent.com/plotly/datasets/master/2014_usa_states.csv',
    ],
    expectContentType: /^text\/csv$/,
  },
];

const HOSTED_FIXTURES: HostedFixture[] = [
  {
    label: 'youtube',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_YOUTUBE_URLS'),
  },
  {
    label: 'vimeo',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_VIMEO_URLS', ['https://vimeo.com/76979871']),
  },
  {
    label: 'reddit',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_REDDIT_URLS'),
  },
  {
    label: 'x-twitter',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_X_URLS'),
  },
  {
    label: 'peertube',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_PEERTUBE_URLS'),
  },
  {
    label: 'imgur',
    urls: envUrls('DEEPMARKS_MEDIA_SMOKE_IMGUR_URLS'),
  },
];

describe.skipIf(!RUN)('live media archive smoke fixtures', () => {
  it.each(DIRECT_FIXTURES)('downloads a seeded $label fixture', async (fixture) => {
    const url = seededPick(fixture.urls, `${SEED}:${fixture.label}`);
    const archive = await tryDownloadDirectFileArchive(url, { force: true });
    expect(archive, `${fixture.label} fixture did not produce archive bytes: ${url}`).toBeTruthy();
    expect(archive!.bytes.byteLength).toBeGreaterThan(0);
    expect(archive!.contentType).toMatch(fixture.expectContentType);
  }, 45_000);

  describe.skipIf(!RUN_HOSTED)('hosted yt-dlp extractor fixtures', () => {
    it.each(HOSTED_FIXTURES.filter((fixture) => fixture.urls.length > 0))('simulates a seeded $label extraction', async (fixture) => {
      const url = seededPick(fixture.urls, `${SEED}:${fixture.label}`);
      const result = await ytDlpSimulate(url);
      expect(result.title.length, `${fixture.label} returned an empty title for ${url}`).toBeGreaterThan(0);
    }, 90_000);
  });
});

function envUrls(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function seededPick<T>(items: T[], seed: string): T {
  if (items.length === 0) throw new Error(`empty fixture list for ${seed}`);
  return items[seededIndex(seed, items.length)]!;
}

function seededIndex(seed: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) % modulo;
}

function ytDlpSimulate(url: string): Promise<{ title: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [
      '--simulate',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--print', 'title',
      url,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`yt-dlp simulate timed out for ${url}`));
    }, 80_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp simulate failed for ${url}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ title: stdout.trim().split('\n')[0] ?? '' });
    });
  });
}
