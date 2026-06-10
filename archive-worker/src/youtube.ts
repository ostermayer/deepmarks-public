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
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoArchiveResult {
  /** Final media bytes. Usually MP4 for video; audio-only sources may use an audio container. */
  blob: Buffer;
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

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // 10 min hard cap per video
const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB guard

/**
 * Download the primary video at `url` to a temp directory and return
 * the resulting bytes + metadata. Cleans up the temp dir on the way
 * out. Caller must run SSRF checks before invoking this because yt-dlp
 * will fetch the URL directly.
 */
export async function downloadVideoArchive(
  input: { url: string; videoId?: string },
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<VideoArchiveResult> {
  const sourceUrl = input.videoId ? `https://www.youtube.com/watch?v=${input.videoId}` : input.url;
  if (input.videoId && !/^[a-zA-Z0-9_-]{11}$/.test(input.videoId)) {
    throw new Error('invalid YouTube video id');
  }
  const workdir = await mkdtemp(join(tmpdir(), 'deepmarks-video-'));
  try {
    // 1. Metadata pass — cheap (~1 round-trip), gives us title/channel
    //    BEFORE the download so the callback can surface them even on
    //    download failure / partial result.
    const meta = await ytDlpMetadata(sourceUrl, workdir, logger);

    const sidecars = await collectYtDlpSidecars(sourceUrl, workdir, logger).catch((err) => {
      logger.warn({ err }, 'yt-dlp sidecar collection failed');
      return [];
    });

    const blobPath = await downloadBestPlayableMedia(sourceUrl, workdir, logger);
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
    const blob = await readFile(finalPath);
    if (blob.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`media archive too large: ${blob.byteLength} bytes`);
    }
    return {
      blob,
      mseCodecs,
      title: meta.title || (input.videoId ? `youtube · ${input.videoId}` : sourceUrl),
      channel: meta.channel || '',
      durationSeconds: meta.durationSeconds || 0,
      mediaKind,
      contentType: mediaKind === 'audio' ? contentTypeForAudioPath(blobPath) : contentTypeForVideoPath(blobPath),
      sidecars,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectYtDlpSidecars(
  sourceUrl: string,
  workdir: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
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
  );
  const entries = await readdir(sidecarDir).catch(() => []);
  const sidecars: MediaSidecar[] = [];
  let totalBytes = 0;
  for (const name of entries.sort()) {
    if (sidecars.length >= 7) break;
    if (name.endsWith('.part') || name.endsWith('.ytdl')) continue;
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
): Promise<string> {
  const mp4Dir = join(workdir, 'mp4');
  await mkdir(mp4Dir, { recursive: true });
  try {
    await runYtDlp(
      [
        '--no-warnings',
        '--no-playlist',
        '--no-progress',
        '--format', MP4_FORMAT_SELECTOR,
        '--merge-output-format', 'mp4',
        '-o', join(mp4Dir, 'archive.%(ext)s'),
        '--restrict-filenames',
        sourceUrl,
      ],
      DOWNLOAD_TIMEOUT_MS,
      logger,
    );
    return await findDownloadedArchivePath(mp4Dir);
  } catch (err) {
    logger.warn({ err }, 'mp4-compatible media download failed; falling back to mkv');
  }

  const fallbackDir = join(workdir, 'fallback');
  await mkdir(fallbackDir, { recursive: true });
  await runYtDlp(
    [
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      '--format', FALLBACK_FORMAT_SELECTOR,
      '--merge-output-format', 'mkv',
      '--remux-video', 'mkv',
      '-o', join(fallbackDir, 'archive.%(ext)s'),
      '--restrict-filenames',
      sourceUrl,
    ],
    DOWNLOAD_TIMEOUT_MS,
    logger,
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
): Promise<void> {
  await runYtDlpCapture(args, timeoutMs, undefined, logger);
}

async function runYtDlpCapture(
  args: string[],
  timeoutMs: number,
  cwd: string | undefined,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('yt-dlp', withOperatorCookies(args), {
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

function withOperatorCookies(args: string[]): string[] {
  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  return cookiesFile ? ['--cookies', cookiesFile, ...args] : args;
}

/** Ensure the user-supplied directory exists. Useful in tests. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
