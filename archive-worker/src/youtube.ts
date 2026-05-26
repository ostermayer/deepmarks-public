// Media archive download — run yt-dlp as a subprocess, capture the
// primary video or audio file + metadata, hand back a buffer for the rest of
// the archive pipeline (encrypt -> upload to Blossom).
//
// Format choice:
//   - Container: MKV (Matroska, open).
//   - Video: VP9 (royalty-free, ~50% smaller than H.264 at same quality).
//   - Audio: Opus (royalty-free, smaller than AAC/MP3 at same quality).
//   - Many large providers ship VP9/Opus as native streams, so this is
//     usually a no-transcode mux — fast, no quality loss, and the binary
//     footprint stays as small as the source allows.
//
// 720p cap enforced at the format-selector level so we never download
// 1080p+ streams. yt-dlp falls back gracefully to the best available
// quality under the cap if 720p isn't published.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoArchiveResult {
  /** Final media bytes. Usually MKV for video; audio-only sources may use an audio container. */
  blob: Buffer;
  /** Video title as reported by yt-dlp's --print=title pass. */
  title: string;
  /** Channel/uploader name as reported by --print=uploader. */
  channel: string;
  /** Duration in seconds (rounded down). */
  durationSeconds: number;
  mediaKind: 'video' | 'audio';
  contentType: string;
}

const FORMAT_SELECTOR = [
  // Prefer native VP9 video + Opus audio with a 720p height cap. yt-dlp
  // syntax: `bestvideo[height<=720][vcodec~=...]+bestaudio[acodec=opus]`.
  // The trailing `/` chain gives progressive fallbacks so even tracks
  // missing VP9/Opus still resolve to a valid stream.
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
 * Download the primary video at `url` to a temp directory, mux into
 * MKV, and return the resulting bytes + metadata. Cleans up the temp
 * dir on the way out. Caller must run SSRF checks before invoking this
 * because yt-dlp will fetch the URL directly.
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

    // 2. Download + remux to MKV. `--merge-output-format mkv` makes
    //    yt-dlp call ffmpeg internally to combine the separate video
    //    and audio streams into one MKV file with stream copies (no
    //    re-encode).
    const outputTemplate = join(workdir, 'archive.%(ext)s');
    await runYtDlp(
      [
        '--no-warnings',
        '--no-playlist',
        '--no-call-home',
        '--no-progress',
        '--format', FORMAT_SELECTOR,
        '--merge-output-format', 'mkv',
        '--remux-video', 'mkv',
        '-o', outputTemplate,
        '--restrict-filenames',
        sourceUrl,
      ],
      DOWNLOAD_TIMEOUT_MS,
      logger,
    );

    const blobPath = await findDownloadedArchivePath(workdir);
    const blob = await readFile(blobPath);
    if (blob.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`media archive too large: ${blob.byteLength} bytes`);
    }
    const mediaKind = isAudioOnlyPath(blobPath) ? 'audio' : 'video';
    return {
      blob,
      title: meta.title || (input.videoId ? `youtube · ${input.videoId}` : sourceUrl),
      channel: meta.channel || '',
      durationSeconds: meta.durationSeconds || 0,
      mediaKind,
      contentType: mediaKind === 'audio' ? contentTypeForAudioPath(blobPath) : 'video/x-matroska',
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
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
  if (name.endsWith('.mkv')) return 10;
  if (name.endsWith('.webm')) return 9;
  if (name.endsWith('.mka')) return 8;
  if (name.endsWith('.opus')) return 7;
  if (name.endsWith('.m4a')) return 6;
  if (name.endsWith('.mp3')) return 5;
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
      '--no-call-home',
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
    const child = spawn('yt-dlp', args, {
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

/** Ensure the user-supplied directory exists. Useful in tests. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
