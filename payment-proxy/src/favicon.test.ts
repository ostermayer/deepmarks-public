import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SVG,
  FaviconStore,
  normalizeHost,
  sniffImageExtension,
  type FaviconConfig,
  type FaviconSource,
} from './favicon.js';

// ── FakeRedis: enough surface for the fields FaviconStore touches ─────

class FakeRedis {
  kv = new Map<string, string>();
  ttl = new Map<string, number>();
  async get(k: string) { return this.kv.get(k) ?? null; }
  async set(k: string, v: string, ...args: (string | number)[]) {
    this.kv.set(k, v);
    const exIdx = args.findIndex((a) => a === 'EX');
    if (exIdx !== -1) this.ttl.set(k, args[exIdx + 1] as number);
    return 'OK';
  }
}

// ── FakeS3: records sends so we can assert upload behavior ────────────

class FakeS3 {
  heads: string[] = [];
  puts: Array<{ Key: string; ContentType: string; bytes: number; ACL: string }> = [];
  headMissing = true;
  headError: Error | null = null;
  putError: Error | null = null;

  async send(cmd: unknown) {
    // Each AWS SDK v3 command has an `input` shape we can inspect.
    const input = (cmd as { input: Record<string, unknown> }).input ?? {};
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    if (name === 'HeadObjectCommand') {
      this.heads.push(String(input.Key));
      if (this.headError) throw this.headError;
      if (this.headMissing) {
        const err = new Error('not found');
        (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
        (err as unknown as { name: string }).name = 'NotFound';
        throw err;
      }
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (name === 'PutObjectCommand') {
      if (this.putError) throw this.putError;
      const body = input.Body as Uint8Array | string;
      this.puts.push({
        Key: String(input.Key),
        ContentType: String(input.ContentType),
        bytes: typeof body === 'string' ? body.length : body.byteLength,
        ACL: String(input.ACL),
      });
      return { $metadata: { httpStatusCode: 200 } };
    }
    throw new Error(`unexpected command ${name}`);
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const TEST_CONFIG: FaviconConfig = {
  endpoint: 'https://us-southeast-1.linodeobjects.com',
  region: 'us-southeast-1',
  bucket: 'deepmarks-favicons',
  accessKey: 'k',
  secretKey: 's',
  publicBase: 'https://deepmarks-favicons.us-southeast-1.linodeobjects.com',
};

// PNG 8-byte header + 1 byte so sniffer accepts it.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

// ── normalizeHost ─────────────────────────────────────────────────────

describe('normalizeHost', () => {
  it('accepts a plain host', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
  });
  it('lowercases', () => {
    expect(normalizeHost('EXAMPLE.com')).toBe('example.com');
  });
  it('strips scheme, path, query, fragment', () => {
    expect(normalizeHost('https://example.com/foo?x=1#y')).toBe('example.com');
  });
  it('strips port and userinfo', () => {
    expect(normalizeHost('user:pw@example.com:8080')).toBe('example.com');
  });
  it('strips trailing dot', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });
  it('rejects non-strings', () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(42)).toBeNull();
  });
  it('rejects single-label hosts', () => {
    expect(normalizeHost('localhost')).toBeNull();
    expect(normalizeHost('intranet')).toBeNull();
  });
  it('rejects IPv4 literals', () => {
    expect(normalizeHost('127.0.0.1')).toBeNull();
    expect(normalizeHost('10.0.0.1')).toBeNull();
  });
  it('rejects illegal characters', () => {
    expect(normalizeHost('foo_bar.com')).toBeNull();
    expect(normalizeHost('foo bar.com')).toBeNull();
    // Non-ASCII must be Punycode-encoded before reaching us.
    expect(normalizeHost('münchen.de')).toBeNull();
  });
  it('rejects empty labels and bad dashes', () => {
    expect(normalizeHost('foo..com')).toBeNull();
    expect(normalizeHost('-foo.com')).toBeNull();
    expect(normalizeHost('foo-.com')).toBeNull();
  });
  it('rejects overlong input', () => {
    expect(normalizeHost('a'.repeat(300) + '.com')).toBeNull();
  });
});

// ── sniffImageExtension ───────────────────────────────────────────────

describe('sniffImageExtension', () => {
  it('recognizes PNG', () => {
    expect(sniffImageExtension(PNG_BYTES)).toBe('png');
  });
  it('recognizes ICO', () => {
    expect(sniffImageExtension(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x00]))).toBe('ico');
  });
  it('recognizes JPEG', () => {
    expect(sniffImageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
  });
  it('recognizes GIF', () => {
    expect(sniffImageExtension(new TextEncoder().encode('GIF89a...'))).toBe('gif');
  });
  it('recognizes WEBP', () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);   // RIFF
    bytes.set([0, 0, 0, 0], 4);                // size placeholder
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);   // WEBP
    expect(sniffImageExtension(bytes)).toBe('webp');
  });
  it('recognizes SVG text', () => {
    const svg = '<?xml version="1.0"?>\n<svg xmlns="..." width="32" height="32"/>';
    expect(sniffImageExtension(new TextEncoder().encode(svg))).toBe('svg');
  });
  it('returns null for HTML', () => {
    expect(sniffImageExtension(new TextEncoder().encode('<!doctype html>'))).toBeNull();
  });
  it('returns null for empty / too-short input', () => {
    expect(sniffImageExtension(new Uint8Array([]))).toBeNull();
    expect(sniffImageExtension(new Uint8Array([0x89]))).toBeNull();
  });
});

// ── FaviconStore.resolveUrl ───────────────────────────────────────────

function makeSource(name: string, bytes: Uint8Array | null): FaviconSource {
  return {
    name,
    fetch: async () => (bytes ? { bytes, ext: sniffImageExtension(bytes)! } : null),
  };
}

describe('FaviconStore.resolveUrl', () => {
  let redis: FakeRedis;
  let s3: FakeS3;
  let store: FaviconStore;

  beforeEach(() => {
    redis = new FakeRedis();
    s3 = new FakeS3();
    silentLogger.info.mockReset();
    silentLogger.warn.mockReset();
    silentLogger.error.mockReset();
  });

  it('returns the public URL on a hit from the first source and caches it', async () => {
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [makeSource('direct', PNG_BYTES)],
    );
    const url = await store.resolveUrl('example.com');
    expect(url).toBe('https://deepmarks-favicons.us-southeast-1.linodeobjects.com/icons/example.com.png');
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0].Key).toBe('icons/example.com.png');
    expect(s3.puts[0].ACL).toBe('public-read');
    // Redis hit marker persisted.
    const marker = JSON.parse(redis.kv.get('dm:favicon:example.com')!);
    expect(marker.kind).toBe('hit');
    expect(marker.ext).toBe('png');
    expect(marker.source).toBe('direct');
  });

  it('falls through to later sources when earlier ones return null', async () => {
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [
        makeSource('direct', null),
        makeSource('homepage', null),
        makeSource('google', PNG_BYTES),
      ],
    );
    const url = await store.resolveUrl('example.com');
    expect(url).toContain('/icons/example.com.png');
    const marker = JSON.parse(redis.kv.get('dm:favicon:example.com')!);
    expect(marker.source).toBe('google');
  });

  it('writes a miss marker and returns the default URL when every source fails', async () => {
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [makeSource('direct', null), makeSource('google', null)],
    );
    const url = await store.resolveUrl('broken.example');
    expect(url).toBe('https://deepmarks-favicons.us-southeast-1.linodeobjects.com/default.svg');
    expect(s3.puts).toHaveLength(0);
    const marker = JSON.parse(redis.kv.get('dm:favicon:broken.example')!);
    expect(marker.kind).toBe('miss');
  });

  it('short-circuits on a Redis hit marker without touching upstream sources', async () => {
    const sourceSpy = vi.fn();
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [{ name: 'direct', fetch: sourceSpy }],
    );
    await redis.set(
      'dm:favicon:example.com',
      JSON.stringify({ kind: 'hit', ext: 'ico', source: 'direct', at: 1 }),
    );
    const url = await store.resolveUrl('example.com');
    expect(url).toBe('https://deepmarks-favicons.us-southeast-1.linodeobjects.com/icons/example.com.ico');
    expect(sourceSpy).not.toHaveBeenCalled();
    expect(s3.puts).toHaveLength(0);
  });

  it('short-circuits on a Redis miss marker and returns the default', async () => {
    const sourceSpy = vi.fn();
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [{ name: 'direct', fetch: sourceSpy }],
    );
    await redis.set(
      'dm:favicon:broken.example',
      JSON.stringify({ kind: 'miss', at: 1 }),
    );
    const url = await store.resolveUrl('broken.example');
    expect(url).toBe('https://deepmarks-favicons.us-southeast-1.linodeobjects.com/default.svg');
    expect(sourceSpy).not.toHaveBeenCalled();
  });

  it('falls through to the next source when the upload step throws', async () => {
    s3.putError = new Error('s3 down');
    const sources: FaviconSource[] = [
      makeSource('direct', PNG_BYTES),
      makeSource('google', PNG_BYTES),
    ];
    store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      sources,
    );
    // Both sources return bytes; both uploads fail; we end up at default.
    const url = await store.resolveUrl('s3down.example');
    expect(url).toBe('https://deepmarks-favicons.us-southeast-1.linodeobjects.com/default.svg');
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

// ── ensureDefaultExists ───────────────────────────────────────────────

describe('FaviconStore.ensureDefaultExists', () => {
  it('uploads default.svg when HeadObject reports a 404', async () => {
    const redis = new FakeRedis();
    const s3 = new FakeS3();
    s3.headMissing = true;
    const store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [],
    );
    await store.ensureDefaultExists();
    expect(s3.puts).toHaveLength(1);
    expect(s3.puts[0].Key).toBe('default.svg');
    expect(s3.puts[0].ContentType).toBe('image/svg+xml');
    expect(s3.puts[0].bytes).toBe(DEFAULT_SVG.length);
    expect(s3.puts[0].ACL).toBe('public-read');
  });

  it('skips upload when HeadObject succeeds', async () => {
    const redis = new FakeRedis();
    const s3 = new FakeS3();
    s3.headMissing = false;
    const store = new FaviconStore(
      redis as unknown as import('ioredis').Redis,
      s3 as unknown as import('@aws-sdk/client-s3').S3Client,
      TEST_CONFIG,
      silentLogger,
      [],
    );
    await store.ensureDefaultExists();
    expect(s3.puts).toHaveLength(0);
  });
});
