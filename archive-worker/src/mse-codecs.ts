// MSE preparation for archived media: probe codecs with ffprobe and
// remux MP4-family files into fragmented MP4 so the client can stream
// chunks straight into a MediaSource buffer (instant playback) instead
// of downloading + decrypting the whole file before play.
//
// Everything here is best-effort: any failure (unmappable codec,
// ffprobe/ffmpeg error) simply yields no `mseCodecs` string, and the
// client falls back to the bounded-memory Blob path that always works.

import { spawn } from 'node:child_process';

export interface ProbedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
}

/** Build an RFC 6381 MSE type string ("video/mp4; codecs=...") from
 *  ffprobe streams. Returns null when any stream can't be mapped —
 *  callers then skip MSE and use the Blob fallback. Pure (tested). */
export function buildMseType(streams: ProbedStream[], container: 'video/mp4' | 'audio/mp4'): string | null {
  const codecs: string[] = [];
  for (const stream of streams) {
    if (stream.codec_type !== 'video' && stream.codec_type !== 'audio') continue;
    const codec = mapStreamToRfc6381(stream);
    if (!codec) return null;
    codecs.push(codec);
  }
  if (codecs.length === 0) return null;
  return `${container}; codecs="${codecs.join(',')}"`;
}

function mapStreamToRfc6381(stream: ProbedStream): string | null {
  switch (stream.codec_name) {
    case 'h264': {
      // avc1.PPCCLL — profile_idc, constraint flags, level_idc in hex.
      const profiles: Record<string, string> = {
        'Constrained Baseline': '4240',
        Baseline: '4200',
        Main: '4D40',
        High: '6400',
      };
      const profile = profiles[stream.profile ?? ''];
      const level = typeof stream.level === 'number' && stream.level > 0 ? stream.level : null;
      if (!profile || level === null) return null;
      return `avc1.${profile}${level.toString(16).padStart(2, '0').toUpperCase()}`;
    }
    case 'hevc':
      // Generic Main-profile signal — broadly accepted by MSE
      // implementations that support HEVC at all.
      return 'hvc1.1.6.L93.B0';
    case 'av1':
      return 'av01.0.04M.08';
    case 'aac':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp4a.40.34';
    case 'opus':
      return 'opus';
    case 'flac':
      return 'flac';
    default:
      return null;
  }
}

export async function probeStreams(path: string): Promise<ProbedStream[]> {
  const json = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,profile,level',
    '-of', 'json',
    path,
  ]);
  const parsed = JSON.parse(json) as { streams?: ProbedStream[] };
  return parsed.streams ?? [];
}

/** Remux (no re-encode) into fragmented MP4 — the byte-stream format
 *  MediaSource buffers accept at arbitrary append boundaries, which is
 *  what lets the client feed decrypted 8 MiB chunks straight in. */
export async function remuxToFragmentedMp4(inputPath: string, outputPath: string): Promise<void> {
  await run('ffmpeg', [
    '-v', 'error',
    '-i', inputPath,
    '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-y',
    outputPath,
  ]);
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}
