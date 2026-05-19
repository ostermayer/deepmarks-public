// YouTube archive download — run yt-dlp as a subprocess, capture the
// video file + metadata, hand back a buffer for the rest of the
// archive pipeline (encrypt → upload to Blossom).
//
// Format choice:
//   - Container: MKV (Matroska, open).
//   - Video: VP9 (royalty-free, ~50% smaller than H.264 at same quality).
//   - Audio: Opus (royalty-free, smaller than AAC/MP3 at same quality).
//   - YouTube ships both VP9 and Opus as native streams so this is a
//     no-transcode mux — fast, no quality loss, and the binary footprint
//     stays as small as the source allows.
//
// 720p cap enforced at the format-selector level so we never download
// 1080p+ streams. yt-dlp falls back gracefully to the best available
// quality under the cap if 720p isn't published.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface YoutubeArchiveResult {
  /** Final MKV bytes — VP9 video + Opus audio. */
  blob: Buffer;
  /** Video title as reported by yt-dlp's --print=title pass. */
  title: string;
  /** Channel/uploader name as reported by --print=uploader. */
  channel: string;
  /** Duration in seconds (rounded down). */
  durationSeconds: number;
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
].join('/');

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // 10 min hard cap per video
const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB guard

/**
 * Download `videoId` to a temp directory, mux into MKV, and return the
 * resulting bytes + metadata. Cleans up the temp dir on the way out.
 *
 * Never trusts the surrounding network — yt-dlp talks to youtube.com
 * directly, so no SSRF surface is added beyond what the binary itself
 * does. We pass the videoId, not the user-supplied URL, so a malicious
 * URL that parsed-then-canonicalised to a bad ID can't escape the
 * shape we expect.
 */
export async function downloadYoutubeArchive(
  videoId: string,
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<YoutubeArchiveResult> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error('invalid YouTube video id');
  }
  const workdir = await mkdtemp(join(tmpdir(), 'deepmarks-yt-'));
  try {
    // 1. Metadata pass — cheap (~1 round-trip), gives us title/channel
    //    BEFORE the download so the callback can surface them even on
    //    download failure / partial result.
    const meta = await ytDlpMetadata(videoId, workdir, logger);

    // 2. Download + remux to MKV. `--merge-output-format mkv` makes
    //    yt-dlp call ffmpeg internally to combine the separate video
    //    and audio streams into one MKV file with stream copies (no
    //    re-encode).
    const outputTemplate = join(workdir, '%(id)s.%(ext)s');
    await runYtDlp(
      [
        '--no-warnings',
        '--no-playlist',
        '--no-call-home',
        '--no-progress',
        '--format', FORMAT_SELECTOR,
        '--merge-output-format', 'mkv',
        '-o', outputTemplate,
        '--restrict-filenames',
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      DOWNLOAD_TIMEOUT_MS,
      logger,
    );

    const blobPath = join(workdir, `${videoId}.mkv`);
    const blob = await readFile(blobPath);
    if (blob.byteLength > MAX_BLOB_BYTES) {
      throw new Error(`youtube archive too large: ${blob.byteLength} bytes`);
    }
    return {
      blob,
      title: meta.title || `youtube · ${videoId}`,
      channel: meta.channel || '',
      durationSeconds: meta.durationSeconds || 0,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ytDlpMetadata(
  videoId: string,
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
      `https://www.youtube.com/watch?v=${videoId}`,
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
