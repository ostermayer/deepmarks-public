// Passkey-encrypted user-nsec ciphertext storage.
//
// Opaque AES-GCM blobs uploaded by the client after a successful WebAuthn
// registration. We never hold the encryption key — the key is derived
// from the user's passkey via the PRF extension and lives only inside
// the browser. Compromising our server yields ciphertext that nobody
// (including us) can decrypt without the user's passkey.
//
// Storage: a dedicated Linode Object Storage bucket (LINODE_CIPHERTEXT_BUCKET).
// Same access keys as the favicon bucket since they live on the same
// region; a separate bucket keeps blast radius tight and makes it
// trivial to graduate to stricter storage later (separate keypair,
// dedicated VPC, etc) without code churn elsewhere.
//
// Object key format: `nsec/<64-char-lowercase-pubkey>` — simple 1:1
// with the user's Nostr pubkey. Size-capped at 4 KB (generous for an
// encrypted 32-byte nsec + IV + metadata).

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';

export const CIPHERTEXT_MAX_BYTES = 4 * 1024;

export interface CiphertextConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface CiphertextLogger {
  info: (msg: object | string, ...rest: unknown[]) => void;
  warn: (msg: object | string, ...rest: unknown[]) => void;
  error: (msg: object | string, ...rest: unknown[]) => void;
}

export function ciphertextConfigFromEnv(): CiphertextConfig | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.LINODE_CIPHERTEXT_BUCKET ?? 'ciphertext';
  const accessKey = process.env.LINODE_ACCESS_KEY;
  const secretKey = process.env.LINODE_SECRET_KEY;
  const region = process.env.S3_REGION ?? 'us-southeast-1';
  if (!endpoint || !accessKey || !secretKey) return null;
  return { endpoint, region, bucket, accessKey, secretKey };
}

export function buildCiphertextS3Client(config: CiphertextConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

function keyFor(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('invalid pubkey format');
  return `nsec/${pubkey}`;
}

export class CiphertextStore {
  constructor(
    private readonly s3: S3Client,
    private readonly config: CiphertextConfig,
    private readonly logger: CiphertextLogger,
  ) {}

  /** Upload (or replace) a user's encrypted nsec blob. Idempotent. */
  async put(pubkey: string, ciphertext: Uint8Array): Promise<void> {
    if (ciphertext.byteLength === 0) throw new Error('empty ciphertext');
    if (ciphertext.byteLength > CIPHERTEXT_MAX_BYTES) {
      throw new Error(`ciphertext too large (> ${CIPHERTEXT_MAX_BYTES} bytes)`);
    }
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: keyFor(pubkey),
        Body: ciphertext,
        ContentType: 'application/octet-stream',
        // Default private — these blobs are fetched via our authed
        // endpoint, never directly from the bucket.
        CacheControl: 'private, no-store',
      }),
    );
    this.logger.info({ pubkey, bytes: ciphertext.byteLength }, 'nsec ciphertext stored');
  }

  /** Fetch the user's ciphertext, or null if they haven't stored one. */
  async get(pubkey: string): Promise<Uint8Array | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: keyFor(pubkey) }),
      );
      if (!res.Body) return null;
      const bytes = await res.Body.transformToByteArray();
      if (bytes.byteLength > CIPHERTEXT_MAX_BYTES) {
        this.logger.warn({ pubkey, bytes: bytes.byteLength }, 'oversized ciphertext — refusing');
        return null;
      }
      return bytes;
    } catch (err) {
      if (err instanceof NoSuchKey || err instanceof NotFound || is404(err)) return null;
      throw err;
    }
  }

  async exists(pubkey: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: keyFor(pubkey) }),
      );
      return true;
    } catch (err) {
      if (err instanceof NoSuchKey || err instanceof NotFound || is404(err)) return false;
      throw err;
    }
  }

  /** Tombstone on user request — account deletion / passkey revoke. */
  async delete(pubkey: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: keyFor(pubkey) }),
    );
    this.logger.info({ pubkey }, 'nsec ciphertext removed');
  }
}

function is404(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  return (
    anyErr.$metadata?.httpStatusCode === 404 ||
    anyErr.name === 'NotFound' ||
    anyErr.name === 'NoSuchKey'
  );
}
