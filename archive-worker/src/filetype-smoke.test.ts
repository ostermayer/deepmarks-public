import { afterAll, describe, expect, it } from 'vitest';
import { tryDownloadDirectFileArchive } from './direct-file.js';

const RUN = process.env.DEEPMARKS_FILETYPE_SMOKE === '1';
const REQUIRE_ALL = process.env.DEEPMARKS_FILETYPE_SMOKE_REQUIRE_ALL === '1';
const missingFixtures = new Set<string>();
let downloadedFixtures = 0;

interface FiletypeFixture {
  ext: string;
  label: string;
  expectContentType: RegExp;
  manifestUrl?: string;
  urls?: string[];
}

const sampleManifest = (category: string, format: string) =>
  `https://samplefile.com/samples/${category}/${format}/manifest.json`;

const FILETYPE_FIXTURES: FiletypeFixture[] = [
  fixture('pdf', 'PDF document', /^application\/pdf$/, undefined, ['https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf']),
  fixture('mp3', 'MP3 audio', /^audio\/mpeg$/, sampleManifest('audio', 'mp3')),
  fixture('m4a', 'M4A audio', /^audio\/mp4$/, sampleManifest('audio', 'm4a')),
  fixture('m4b', 'M4B audiobook', /^audio\/mp4$/, sampleManifest('audio', 'm4b')),
  fixture('aac', 'AAC audio', /^audio\/aac$/, sampleManifest('audio', 'aac')),
  fixture('ogg', 'Ogg audio', /^audio\/ogg$/, sampleManifest('audio', 'ogg')),
  fixture('oga', 'OGA audio', /^audio\/ogg$/, sampleManifest('audio', 'oga')),
  fixture('opus', 'Opus audio', /^audio\/opus$/, sampleManifest('audio', 'opus')),
  fixture('wav', 'WAV audio', /^audio\/wav$/, sampleManifest('audio', 'wav')),
  fixture('flac', 'FLAC audio', /^audio\/flac$/, sampleManifest('audio', 'flac')),
  fixture('mp4', 'MP4 video', /^video\/mp4$/, sampleManifest('video', 'mp4')),
  fixture('m4v', 'M4V video', /^video\/mp4$/, sampleManifest('video', 'm4v')),
  fixture('mov', 'QuickTime video', /^video\/quicktime$/, sampleManifest('video', 'mov')),
  fixture('webm', 'WebM video', /^video\/webm$/, sampleManifest('video', 'webm')),
  fixture('mkv', 'Matroska video', /^video\/x-matroska$/, sampleManifest('video', 'mkv')),
  fixture('ogv', 'Ogg video', /^video\/ogg$/, sampleManifest('video', 'ogv')),
  fixture('mpeg', 'MPEG video', /^video\/mpeg$/, sampleManifest('video', 'mpeg')),
  fixture('mpg', 'MPG video', /^video\/mpeg$/, sampleManifest('video', 'mpg')),
  fixture('avi', 'AVI video', /^video\/x-msvideo$/, sampleManifest('video', 'avi')),
  fixture('3gp', '3GP video', /^video\/3gpp$/, sampleManifest('video', '3gp')),
  fixture('jpg', 'JPG image', /^image\/jpeg$/, undefined, ['https://interactive-examples.mdn.mozilla.net/media/examples/plumeria.jpg']),
  fixture('jpeg', 'JPEG image', /^image\/jpeg$/, sampleManifest('image', 'jpeg')),
  fixture('png', 'PNG image', /^image\/png$/, sampleManifest('image', 'png')),
  fixture('webp', 'WebP image', /^image\/webp$/, sampleManifest('image', 'webp')),
  fixture('avif', 'AVIF image', /^image\/avif$/, sampleManifest('image', 'avif')),
  fixture('gif', 'GIF image', /^image\/gif$/, sampleManifest('image', 'gif')),
  fixture('heic', 'HEIC image', /^image\/heic$/, sampleManifest('image', 'heic')),
  fixture('heif', 'HEIF image', /^image\/heif$/, sampleManifest('image', 'heif')),
  fixture('tif', 'TIF image', /^image\/tiff$/, sampleManifest('image', 'tif')),
  fixture('tiff', 'TIFF image', /^image\/tiff$/, sampleManifest('image', 'tiff')),
  fixture('svg', 'SVG image', /^image\/svg\+xml$/, undefined, ['https://upload.wikimedia.org/wikipedia/commons/0/02/SVG_logo.svg']),
  fixture('vtt', 'WebVTT captions', /^text\/vtt$/, sampleManifest('subtitle', 'vtt')),
  fixture('srt', 'SubRip captions', /^application\/x-subrip$/, sampleManifest('subtitle', 'srt')),
  fixture('ttml', 'TTML captions', /^application\/ttml\+xml$/, sampleManifest('subtitle', 'ttml')),
  fixture('lrc', 'LRC lyrics', /^text\/plain$/, sampleManifest('subtitle', 'lrc')),
  fixture('txt', 'plain text', /^text\/plain$/, sampleManifest('data', 'txt')),
  fixture('md', 'Markdown text', /^text\/markdown$/, undefined, ['https://raw.githubusercontent.com/github/docs/main/README.md']),
  fixture('markdown', 'Markdown text', /^text\/markdown$/, sampleManifest('data', 'markdown')),
  fixture('csv', 'CSV data', /^text\/csv$/, undefined, ['https://raw.githubusercontent.com/plotly/datasets/master/2014_usa_states.csv']),
  fixture('json', 'JSON data', /^application\/json$/, undefined, ['https://jsonplaceholder.typicode.com/todos/1']),
  fixture('xml', 'XML data', /^application\/xml$/, undefined, ['https://www.w3schools.com/xml/note.xml']),
  fixture('rss', 'RSS feed', /^application\/rss\+xml$/, sampleManifest('data', 'rss')),
  fixture('epub', 'EPUB ebook', /^application\/epub\+zip$/, sampleManifest('ebook', 'epub')),
  fixture('mobi', 'MOBI ebook', /^application\/x-mobipocket-ebook$/, sampleManifest('ebook', 'mobi')),
  fixture('azw', 'AZW ebook', /^application\/vnd\.amazon\.ebook$/, sampleManifest('ebook', 'azw')),
  fixture('azw3', 'AZW3 ebook', /^application\/vnd\.amazon\.ebook$/, sampleManifest('ebook', 'azw3')),
  fixture('cbz', 'CBZ comic', /^application\/vnd\.comicbook\+zip$/, sampleManifest('ebook', 'cbz')),
  fixture('cbr', 'CBR comic', /^application\/vnd\.comicbook-rar$/, sampleManifest('ebook', 'cbr')),
  fixture('doc', 'Word DOC', /^application\/msword$/, sampleManifest('document', 'doc')),
  fixture('docx', 'Word DOCX', /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/, sampleManifest('document', 'docx')),
  fixture('xls', 'Excel XLS', /^application\/vnd\.ms-excel$/, sampleManifest('document', 'xls')),
  fixture('xlsx', 'Excel XLSX', /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/, sampleManifest('document', 'xlsx')),
  fixture('ppt', 'PowerPoint PPT', /^application\/vnd\.ms-powerpoint$/, sampleManifest('document', 'ppt')),
  fixture('pptx', 'PowerPoint PPTX', /^application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$/, sampleManifest('document', 'pptx')),
  fixture('odt', 'OpenDocument text', /^application\/vnd\.oasis\.opendocument\.text$/, sampleManifest('document', 'odt')),
  fixture('ods', 'OpenDocument spreadsheet', /^application\/vnd\.oasis\.opendocument\.spreadsheet$/, sampleManifest('document', 'ods')),
  fixture('odp', 'OpenDocument presentation', /^application\/vnd\.oasis\.opendocument\.presentation$/, sampleManifest('document', 'odp')),
  fixture('rtf', 'RTF document', /^application\/rtf$/, sampleManifest('document', 'rtf')),
  fixture('zip', 'ZIP archive', /^application\/zip$/, sampleManifest('archive', 'zip')),
  fixture('rar', 'RAR archive', /^application\/vnd\.rar$/, sampleManifest('archive', 'rar')),
  fixture('7z', '7z archive', /^application\/x-7z-compressed$/, sampleManifest('archive', '7z')),
  fixture('tar', 'tar archive', /^application\/x-tar$/, sampleManifest('archive', 'tar')),
  fixture('gz', 'gzip archive', /^application\/gzip$/, sampleManifest('archive', 'gz')),
  fixture('m3u8', 'HLS manifest', /^application\/vnd\.apple\.mpegurl$/, undefined, ['https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8']),
  fixture('m3u', 'M3U playlist', /^application\/vnd\.apple\.mpegurl|^audio\/x-mpegurl$/, sampleManifest('playlist', 'm3u')),
  fixture('pls', 'PLS playlist', /^audio\/x-scpls$/, sampleManifest('playlist', 'pls')),
  fixture('mpd', 'DASH manifest', /^application\/dash\+xml$/, undefined, ['https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd']),
];

describe.skipIf(!RUN)('live direct-file format fixtures', () => {
  it.each(FILETYPE_FIXTURES)('archives a real .$ext $label fixture', async (entry) => {
    const url = await resolveFixtureUrl(entry);
    if (!url) {
      const message = `missing real URL fixture for .${entry.ext}`;
      missingFixtures.add(entry.ext);
      if (REQUIRE_ALL) throw new Error(message);
      console.warn(message);
      return;
    }

    const archive = await tryDownloadDirectFileArchive(url, { force: true });

    expect(archive, `no archive bytes for .${entry.ext}: ${url}`).toBeTruthy();
    expect(archive!.bytes.byteLength).toBeGreaterThan(0);
    expect(archive!.contentType).toMatch(entry.expectContentType);
    downloadedFixtures += 1;
  }, 60_000);

  afterAll(() => {
    console.info(
      `filetype smoke downloaded ${downloadedFixtures}/${FILETYPE_FIXTURES.length} real fixtures` +
      (missingFixtures.size > 0 ? `; missing: ${[...missingFixtures].sort().join(', ')}` : ''),
    );
  });
});

function fixture(
  ext: string,
  label: string,
  expectContentType: RegExp,
  manifestUrl?: string,
  urls: string[] = [],
): FiletypeFixture {
  return {
    ext,
    label,
    expectContentType,
    manifestUrl,
    urls: [...envUrls(`DEEPMARKS_FILETYPE_SMOKE_${ext.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URLS`), ...urls],
  };
}

function envUrls(name: string): string[] {
  const raw = process.env[name];
  return raw ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [];
}

async function resolveFixtureUrl(entry: FiletypeFixture): Promise<string | null> {
  if (entry.urls && entry.urls.length > 0) return entry.urls[0]!;
  if (!entry.manifestUrl) return null;
  const res = await fetch(entry.manifestUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) return null;
  const manifest = await res.json().catch(() => null) as {
    files?: Array<{ url?: string; download_url?: string; size_bytes?: number }>;
  } | null;
  const file = manifest?.files
    ?.filter((candidate) => candidate.url || candidate.download_url)
    .sort((a, b) => (a.size_bytes ?? Number.MAX_SAFE_INTEGER) - (b.size_bytes ?? Number.MAX_SAFE_INTEGER))[0];
  const raw = file?.url ?? file?.download_url;
  return raw ? new URL(raw, entry.manifestUrl).toString() : null;
}
