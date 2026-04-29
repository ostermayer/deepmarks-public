// Direct S3 access to the Blossom server's blob bucket.
//
// blossom.deepmarks.org runs hzrd149/blossom-server with a Linode S3
// bucket as its storage backend. The server addresses every blob by its
// SHA-256 hash (the bucket key is the lowercase-hex hash, no prefix).
// Deleting the S3 object causes Blossom to 404 on subsequent fetches —
// content-addressed storage with no separate index.
//
// This module exists because the BUD-01 DELETE path requires the
// uploader's nsec, which lives on Box B (the worker). For the user-
// facing "delete my archive" flow we'd rather act from the user-
// authenticated payment-proxy than route through the worker; direct
// S3 deletes bypass that constraint entirely.
//
// IMPORTANT: this only deletes our PRIMARY's copy. Mirror operators
// (Primal, Satellite CDN, hzrd149) pulled the bytes via BUD-04 at
// upload time and host them under their own retention policies. We
// can't reach into their buckets. For private archives the ciphertext
// is harmless without the user's AES key (which they control via the
// NIP-51 archive-key set); for public archives the hash is essentially
// permanent once mirrored.

import {
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
  NotFound,
  NoSuchKey,
} from '@aws-sdk/client-s3';

export interface BlossomBlobConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface BlossomBlobLogger {
  info: (msg: object | string, ...rest: unknown[]) => void;
  warn: (msg: object | string, ...rest: unknown[]) => void;
  error: (msg: object | string, ...rest: unknown[]) => void;
}

export function blossomBlobConfigFromEnv(): BlossomBlobConfig | null {
  const endpoint = process.env.S3_ENDPOINT;
  // Same bucket as the blossom-server container's S3_BUCKET — set them
  // to the same value in compose so the two services agree on what
  // they're addressing. Named distinctly here so a future migration
  // can split them if we ever want a separate "user-deletable" pool.
  const bucket = process.env.BLOSSOM_S3_BUCKET ?? process.env.S3_BUCKET;
  const accessKey = process.env.LINODE_ACCESS_KEY;
  const secretKey = process.env.LINODE_SECRET_KEY;
  const region = process.env.S3_REGION ?? 'us-southeast-1';
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return { endpoint, region, bucket, accessKey, secretKey };
}

export function buildBlossomBlobS3Client(config: BlossomBlobConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

function keyFor(blobHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(blobHash)) throw new Error('invalid blob hash format');
  return blobHash;
}

export class BlossomBlobStore {
  constructor(
    private readonly s3: S3Client,
    private readonly config: BlossomBlobConfig,
    private readonly logger: BlossomBlobLogger,
  ) {}

  /** Confirm an object exists in the bucket. Used as a sanity check
   *  before we record a "deleted" event — gives us a richer error
   *  ("blob not found on primary") instead of silently 200ing on a
   *  delete of something that was never there. */
  async exists(blobHash: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: keyFor(blobHash) }),
      );
      return true;
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return false;
      throw err;
    }
  }

  /** Remove the blob from our primary's S3 bucket. Idempotent — a
   *  delete on a non-existent key returns 204 from S3 and we treat
   *  that as success ('already gone'). The caller should still verify
   *  existence first if it cares about the distinction. */
  async delete(blobHash: string): Promise<void> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: keyFor(blobHash) }),
      );
      this.logger.info({ blobHash, bucket: this.config.bucket }, 'blossom blob deleted');
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === 'NoSuchKey') {
        this.logger.info({ blobHash }, 'blossom blob already absent — delete idempotent');
        return;
      }
      throw err;
    }
  }
}
