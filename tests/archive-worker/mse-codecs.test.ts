// RFC 6381 MSE type construction — the string the client passes to
// MediaSource.isTypeSupported/addSourceBuffer for streaming playback.
// Wrong strings don't error loudly; they silently force the Blob
// fallback (or worse, get rejected by Safari only), so pin the mapping.

import { describe, expect, it } from 'vitest';
import { buildMseType } from '@src/mse-codecs.js';

describe('buildMseType', () => {
  it('maps a typical yt-dlp h264+aac download', () => {
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'h264', profile: 'High', level: 31 },
      { codec_type: 'audio', codec_name: 'aac' },
    ], 'video/mp4')).toBe('video/mp4; codecs="avc1.64001F,mp4a.40.2"');
  });

  it('maps constrained baseline + main profiles', () => {
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'h264', profile: 'Constrained Baseline', level: 30 },
    ], 'video/mp4')).toBe('video/mp4; codecs="avc1.42401E"');
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'h264', profile: 'Main', level: 40 },
    ], 'video/mp4')).toBe('video/mp4; codecs="avc1.4D4028"');
  });

  it('maps audio-only aac', () => {
    expect(buildMseType([
      { codec_type: 'audio', codec_name: 'aac' },
    ], 'audio/mp4')).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it('refuses unmappable codecs entirely (forces Blob fallback)', () => {
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'vp9' },
      { codec_type: 'audio', codec_name: 'aac' },
    ], 'video/mp4')).toBeNull();
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'h264', profile: 'High 10', level: 31 },
    ], 'video/mp4')).toBeNull(); // unmapped profile
    expect(buildMseType([
      { codec_type: 'video', codec_name: 'h264', profile: 'High' }, // missing level
    ], 'video/mp4')).toBeNull();
  });

  it('ignores non-AV streams (data/subtitles) but requires at least one codec', () => {
    expect(buildMseType([
      { codec_type: 'data', codec_name: 'bin_data' },
      { codec_type: 'video', codec_name: 'h264', profile: 'High', level: 31 },
    ], 'video/mp4')).toBe('video/mp4; codecs="avc1.64001F"');
    expect(buildMseType([{ codec_type: 'data', codec_name: 'bin_data' }], 'video/mp4')).toBeNull();
  });
});
