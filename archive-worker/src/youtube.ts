// Media archive download — run yt-dlp as a subprocess, capture the
// primary video or audio file + metadata, hand back a buffer for the rest of
// the archive pipeline (encrypt -> upload to Blossom).
//
// Format choice:
//   - Prefer MP4/H.264/AAC so private media archives open in mobile
//     browsers/WebViews without an external player.
//   - Fall back to the older MKV path when a provider does not expose a
//     compatible MP4 stream under the size/quality cap.
//
// 720p cap enforced at the format-selector level so we never download
// 1080p+ streams. yt-dlp falls back gracefully to the best available
// quality under the cap if 720p isn't published.

import { spawn } from 'node:child_process';
import { buildMseType, probeStreams, remuxToFragmentedMp4 } from './mse-codecs.js';
import { isYoutubeVideoId } from './youtube-id.js';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSafeHttpProxy } from './safe-http-proxy.js';
import { residentialSourceIp } from './residential-egress.js';
import { isTweetUrl, resolveTweetVideoUrl } from './tweet-embed.js';

export interface VideoArchiveResult {
  /** Final media bytes. Direct media uses this in-memory path for small files. */
  blob?: Buffer;
  /** Final media file path. Hosted yt-dlp captures use this for large-file safety. */
  filePath?: string;
  /** Final media size in bytes. */
  byteLength?: number;
  /** Removes any temp files backing filePath. Must be called after upload. */
  cleanup?: () => Promise<void>;
  /** Video title as reported by yt-dlp's --print=title pass. */
  title: string;
  /** Channel/uploader name as reported by --print=uploader. */
  channel: string;
  /** Duration in seconds (rounded down). */
  durationSeconds: number;
  mediaKind: 'video' | 'audio' | 'image';
  contentType: string;
  fileName?: string;
  sidecars?: MediaSidecar[];
  /** RFC 6381 MSE type string when the blob was remuxed to fragmented
   *  MP4 with MSE-mappable codecs — lets the client stream-play instead
   *  of downloading the whole file first. Absent → Blob fallback. */
  mseCodecs?: string;
}

export interface MediaSidecar {
  role: 'metadata' | 'thumbnail' | 'caption' | 'chapter';
  bytes: Buffer;
  contentType: string;
  fileName: string;
}

const MP4_FORMAT_SELECTOR = [
  'bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a][acodec^=mp4a]',
  'bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]',
  'best[height<=720][ext=mp4][vcodec^=avc1]',
  'best[height<=720][ext=mp4]',
  'bestaudio[ext=m4a][acodec^=mp4a]',
  'bestaudio[ext=m4a]',
].join('/');

const FALLBACK_FORMAT_SELECTOR = [
  'bestvideo[height<=720][vcodec^=vp9]+bestaudio[acodec=opus]',
  'bestvideo[height<=720][vcodec^=vp9]+bestaudio',
  'bestvideo[height<=720]+bestaudio[acodec=opus]',
  'bestvideo[height<=720]+bestaudio',
  'best[height<=720]',
  'bestaudio[acodec=opus]',
  'bestaudio',
].join('/');

// 20 min hard cap per video. Combined with --concurrent-fragments (below),
// this lets multi-hour lectures/talks/VODs actually finish; the old 10 min
// single-stream cap timed them out on every attempt.
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB guard

/**
 * Download the primary video at `url` to a temp directory and return
 * the resulting bytes + metadata. Cleans up the temp dir on the way
 * out. Caller must run SSRF checks before invoking this because yt-dlp
 * will fetch the URL directly.
 */
export async function downloadVideoArchive(
  input: { url: string; videoId?: string },
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  opts: { maxBytes?: number } = {},
): Promise<VideoArchiveResult> {
  if (input.videoId && !isYoutubeVideoId(input.videoId)) {
    throw new Error('invalid YouTube video id');
  }
  let sourceUrl = input.videoId ? `https://www.youtube.com/watch?v=${input.videoId}` : input.url;
  // yt-dlp can no longer pull video from x.com ("No video could be found in
  // this tweet"), but it downloads the direct mp4 fine. Resolve the tweet to
  // its direct video.twimg.com file via the FixTweet API and hand yt-dlp that
  // instead — the rest of the media pipeline (MSE remux, encrypt) is unchanged.
  if (!input.videoId && isTweetUrl(input.url)) {
    const mp4 = await resolveTweetVideoUrl(input.url).catch(() => null);
    if (mp4) {
      logger.info({ url: input.url, mp4Host: new URL(mp4).hostname }, 'resolved tweet video via FixTweet');
      sourceUrl = mp4;
    }
  }
  // Try the clean PO-token path FIRST, with no cookies. Only if YouTube demands
  // a signed-in session ("sign in to confirm you're not a bot") do we retry
  // once with the operator cookie file. This keeps cookies a targeted fallback:
  // a stale/expired cookie file can only ever break the auth-gated subset, it
  // can never poison the PO-token path that archives the bulk of videos.
  const cookiesConfigured = !!process.env.YTDLP_COOKIES_FILE?.trim();
  // Residential egress is a LAST-DITCH fallback only: every normal attempt runs
  // on the datacenter IP, and we route a job out the home tunnel solely when the
  // datacenter path is still bot-walled. Keeps the residential line used sparingly.
  const residentialIp = residentialSourceIp();
  try {
    return await attemptVideoDownload(sourceUrl, input, logger, opts, false);
  } catch (err) {
    let lastErr: unknown = err;
    if (cookiesConfigured && isYoutubeAuthGate(err)) {
      logger.warn({ err: String(err).slice(0, 200) }, 'youtube auth gate — retrying once with operator cookies');
      try {
        return await attemptVideoDownload(sourceUrl, input, logger, opts, true);
      } catch (err2) {
        lastErr = err2;
      }
    }
    // Still bot-walled on the datacenter IP after exhausting the cookie retry —
    // one final attempt out the residential tunnel. Only on a genuine auth
    // gate / bot wall, and only when the tunnel is configured.
    if (residentialIp && isYoutubeAuthGate(lastErr)) {
      logger.warn({ sourceIp: residentialIp }, 'still bot-walled on datacenter IP — last-ditch retry via residential egress');
      return await attemptVideoDownload(sourceUrl, input, logger, opts, cookiesConfigured, residentialIp);
    }
    throw lastErr;
  }
}

async function attemptVideoDownload(
  sourceUrl: string,
  input: { url: string; videoId?: string },
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  opts: { maxBytes?: number },
  useCookies: boolean,
  residentialIp?: string,
): Promise<VideoArchiveResult> {
  const tempRoot = mediaTempRoot();
  await mkdir(tempRoot, { recursive: true });
  const workdir = await mkdtemp(join(tempRoot, 'deepmarks-video-'));
  // On a last-ditch residential retry the safe proxy source-binds its outbound
  // socket to the wg0 IP, so a Box B source route sends just this one download
  // out the residential tunnel. Datacenter IP otherwise.
  if (residentialIp) {
    logger.info({ url: input.url, sourceIp: residentialIp }, 'download egress via residential tunnel');
  }
  const proxy = await startSafeHttpProxy(residentialIp ? { localAddress: residentialIp } : {});
  let shouldCleanup = true;
  try {
    // 1. Metadata pass — cheap (~1 round-trip), gives us title/channel
    //    BEFORE the download so the callback can surface them even on
    //    download failure / partial result.
    const meta = await ytDlpMetadata(sourceUrl, workdir, logger, proxy.url, useCookies);

    const sidecars = await collectYtDlpSidecars(sourceUrl, workdir, logger, proxy.url, useCookies).catch((err) => {
      logger.warn({ err }, 'yt-dlp sidecar collection failed');
      return [];
    });

    const blobPath = await downloadBestPlayableMedia(sourceUrl, workdir, logger, proxy.url, useCookies);
    const mediaKind = isAudioOnlyPath(blobPath) ? 'audio' : 'video';
    // MSE prep (best-effort): probe codecs and remux MP4-family media to
    // fragmented MP4 so clients can stream-play. Any failure falls back
    // to the original file with no codecs string (Blob playback).
    let finalPath = blobPath;
    let mseCodecs: string | undefined;
    if (/\.(mp4|m4v|m4a|mov)$/i.test(blobPath)) {
      try {
        const streams = await probeStreams(blobPath);
        const mseType = buildMseType(streams, mediaKind === 'audio' ? 'audio/mp4' : 'video/mp4');
        if (mseType) {
          const fragPath = join(workdir, 'fragmented.mp4');
          await remuxToFragmentedMp4(blobPath, fragPath);
          finalPath = fragPath;
          mseCodecs = mseType;
        }
      } catch (err) {
        logger.warn({ err }, 'MSE remux/probe failed — falling back to original container');
      }
    }
    const { size } = await stat(finalPath);
    const maxBytes = opts.maxBytes ?? mediaMaxBytes();
    if (size > maxBytes) {
      throw new Error(`media archive too large: ${size} bytes`);
    }
    shouldCleanup = false;
    return {
      filePath: finalPath,
      byteLength: size,
      cleanup: async () => {
        await proxy.close().catch(() => undefined);
        await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
      },
      mseCodecs,
      title: meta.title || (input.videoId ? `youtube · ${input.videoId}` : sourceUrl),
      channel: meta.channel || '',
      durationSeconds: meta.durationSeconds || 0,
      mediaKind,
      contentType: mediaKind === 'audio' ? contentTypeForAudioPath(blobPath) : contentTypeForVideoPath(blobPath),
      sidecars,
    };
  } finally {
    if (shouldCleanup) {
      await proxy.close().catch(() => undefined);
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function collectYtDlpSidecars(
  sourceUrl: string,
  workdir: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  proxyUrl: string,
  useCookies: boolean,
): Promise<MediaSidecar[]> {
  const sidecarDir = join(workdir, 'sidecars');
  await mkdir(sidecarDir, { recursive: true });
  await runYtDlpCapture(
    [
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      '--skip-download',
      '--write-info-json',
      '--write-thumbnail',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', 'en.*,en',
      '-o', join(sidecarDir, 'sidecar.%(ext)s'),
      '--restrict-filenames',
      sourceUrl,
    ],
    90_000,
    sidecarDir,
    logger,
    proxyUrl,
    useCookies,
  );
  const entries = await readdir(sidecarDir).catch(() => []);
  const sidecars: MediaSidecar[] = [];
  let totalBytes = 0;
  for (const name of entries.sort()) {
    if (sidecars.length >= 7) break;
    if (name.endsWith('.part') || name.endsWith('.ytdl')) continue;
    // stat BEFORE readFile: the size cap used to be checked only after
    // reading the whole file into memory, so one oversized sidecar (a
    // multi-GB stray in the temp dir) could OOM the worker (2026-08-23).
    const info = await stat(join(sidecarDir, name)).catch(() => null);
    if (!info || !info.isFile() || info.size > 5 * 1024 * 1024) continue;
    const bytes = await readFile(join(sidecarDir, name));
    if (bytes.byteLength > 5 * 1024 * 1024) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > 25 * 1024 * 1024) break;
    sidecars.push({
      role: sidecarRole(name),
      bytes,
      contentType: sidecarContentType(name),
      fileName: name,
    });
  }
  return sidecars;
}

function sidecarRole(name: string): MediaSidecar['role'] {
  if (name.endsWith('.info.json')) return 'metadata';
  if (/\.(vtt|srt|ttml|srv\d*)$/i.test(name)) return 'caption';
  if (/chapter/i.test(name)) return 'chapter';
  return 'thumbnail';
}

function sidecarContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  if (lower.endsWith('.srt')) return 'application/x-subrip';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function downloadBestPlayableMedia(
  sourceUrl: string,
  workdir: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  proxyUrl: string,
  useCookies: boolean,
): Promise<string> {
  const mp4Dir = join(workdir, 'mp4');
  await mkdir(mp4Dir, { recursive: true });
  try {
    await runYtDlp(
      [
        '--no-warnings',
        '--no-playlist',
        '--no-progress',
        // Parallel fragment download — large multi-fragment videos finish far
        // faster (and within the timeout) than the old single-stream default.
        '--concurrent-fragments', '4',
        '--format', MP4_FORMAT_SELECTOR,
        '--merge-output-format', 'mp4',
        '-o', join(mp4Dir, 'archive.%(ext)s'),
        '--restrict-filenames',
        sourceUrl,
      ],
      DOWNLOAD_TIMEOUT_MS,
      logger,
      proxyUrl,
      useCookies,
    );
    return await findDownloadedArchivePath(mp4Dir);
  } catch (err) {
    // Re-throw an auth gate so the caller can retry the whole job with
    // cookies; only a non-auth failure falls through to the mkv attempt.
    if (isYoutubeAuthGate(err)) throw err;
    logger.warn({ err }, 'mp4-compatible media download failed; falling back to mkv');
  }

  const fallbackDir = join(workdir, 'fallback');
  await mkdir(fallbackDir, { recursive: true });
  await runYtDlp(
    [
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      '--concurrent-fragments', '4',
      '--format', FALLBACK_FORMAT_SELECTOR,
      '--merge-output-format', 'mkv',
      '--remux-video', 'mkv',
      '-o', join(fallbackDir, 'archive.%(ext)s'),
      '--restrict-filenames',
      sourceUrl,
    ],
    DOWNLOAD_TIMEOUT_MS,
    logger,
    proxyUrl,
    useCookies,
  );
  return findDownloadedArchivePath(fallbackDir);
}

async function findDownloadedArchivePath(workdir: string): Promise<string> {
  const entries = await readdir(workdir);
  const candidate = entries
    .filter((name) => name.startsWith('archive.'))
    .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl') && !name.endsWith('.info.json'))
    .sort((a, b) => scoreArchiveName(b) - scoreArchiveName(a))[0];
  if (!candidate) throw new Error('yt-dlp did not produce an archive file');
  return join(workdir, candidate);
}

function scoreArchiveName(name: string): number {
  if (name.endsWith('.mp4')) return 12;
  if (name.endsWith('.m4v')) return 11;
  if (name.endsWith('.mov')) return 10;
  if (name.endsWith('.webm')) return 9;
  if (name.endsWith('.mkv')) return 8;
  if (name.endsWith('.mka')) return 7;
  if (name.endsWith('.opus')) return 6;
  if (name.endsWith('.m4a')) return 5;
  if (name.endsWith('.mp3')) return 4;
  return 1;
}

function isAudioOnlyPath(path: string): boolean {
  return /\.(mka|opus|m4a|mp3|aac|ogg|oga|wav|flac)$/i.test(path);
}

function contentTypeForAudioPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.opus')) return 'audio/opus';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.mka')) return 'audio/x-matroska';
  return 'audio/mpeg';
}

function contentTypeForVideoPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.ogv')) return 'video/ogg';
  return 'video/x-matroska';
}

export async function downloadYoutubeArchive(
  videoId: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<VideoArchiveResult> {
  return downloadVideoArchive({ url: `https://www.youtube.com/watch?v=${videoId}`, videoId }, logger);
}

async function ytDlpMetadata(
  sourceUrl: string,
  workdir: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  proxyUrl: string,
  useCookies: boolean,
): Promise<{ title: string; channel: string; durationSeconds: number }> {
  // `--print` emits one line per field. Order matters — we slice by line.
  const out = await runYtDlpCapture(
    [
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      '--print', 'title',
      '--print', 'uploader',
      '--print', 'duration',
      sourceUrl,
    ],
    60_000,
    workdir,
    logger,
    proxyUrl,
    useCookies,
  );
  const lines = out.split('\n').filter((l) => l.length > 0);
  const [title, channel, durationStr] = [lines[0] ?? '', lines[1] ?? '', lines[2] ?? '0'];
  const durationSeconds = Math.floor(Number(durationStr) || 0);
  return { title, channel, durationSeconds };
}

async function runYtDlp(
  args: string[],
  timeoutMs: number,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  proxyUrl: string,
  useCookies: boolean,
): Promise<void> {
  await runYtDlpCapture(args, timeoutMs, undefined, logger, proxyUrl, useCookies);
}

async function runYtDlpCapture(
  args: string[],
  timeoutMs: number,
  cwd: string | undefined,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  proxyUrl: string,
  useCookies: boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('yt-dlp', withPotProvider(withOperatorCookies(withSafeProxy(args, proxyUrl), useCookies)), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(0, 2_000) }, 'yt-dlp non-zero exit');
        reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function withOperatorCookies(args: string[], useCookies: boolean): string[] {
  // Cookies are a deliberate fallback, attached ONLY on the cookie retry of an
  // auth-gated video (see downloadVideoArchive). Never on the first/PO-token
  // pass — so a stale cookie file cannot poison the formats yt-dlp returns for
  // the public-video bulk.
  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  return useCookies && cookiesFile ? ['--cookies', cookiesFile, ...args] : args;
}

/** YouTube is demanding a signed-in session (age/sensitive-content gate or an
 *  IP-reputation challenge). Only these errors justify the cookie retry. */
export function isYoutubeAuthGate(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /sign in to confirm/i.test(msg)
    || /confirm you[’'`]?re not a bot/i.test(msg)
    || /account authentication is required/i.test(msg)
    || /this video may be inappropriate/i.test(msg)
    || /sign in to (?:view|confirm your age)/i.test(msg);
}

function withPotProvider(args: string[]): string[] {
  // YouTube gates most formats behind a BotGuard PO token. The bgutil yt-dlp
  // plugin fetches one from the provider sidecar; without this base_url (or
  // if the provider is down) yt-dlp falls back to legacy ~360p only.
  const baseUrl = process.env.YTDLP_POT_PROVIDER_URL?.trim();
  return baseUrl
    ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${baseUrl}`, ...args]
    : args;
}

function withSafeProxy(args: string[], proxyUrl: string): string[] {
  return ['--proxy', proxyUrl, ...args];
}

function mediaTempRoot(): string {
  return process.env.MEDIA_ARCHIVE_TMPDIR?.trim() || tmpdir();
}

function mediaMaxBytes(): number {
  const raw = process.env.MEDIA_ARCHIVE_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BLOB_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BLOB_BYTES;
}

/** Ensure the user-supplied directory exists. Useful in tests. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
