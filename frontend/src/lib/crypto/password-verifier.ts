const DEFAULT_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface PasswordVerifierRecord {
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  saltB64: string;
  hashB64: string;
}

export async function createPasswordVerifier(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<PasswordVerifierRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, iterations);
  return {
    algorithm: 'pbkdf2-sha256',
    iterations,
    saltB64: bytesToB64(salt),
    hashB64: bytesToB64(hash),
  };
}

export async function verifyPassword(
  password: string,
  record: PasswordVerifierRecord,
): Promise<boolean> {
  if (record.algorithm !== 'pbkdf2-sha256' || record.iterations < 100_000) return false;
  const salt = b64ToBytes(record.saltB64);
  const expected = b64ToBytes(record.hashB64);
  const actual = await derivePasswordHash(password, salt, record.iterations);
  return timingSafeEqual(actual, expected);
}

export function isPasswordVerifierRecord(value: unknown): value is PasswordVerifierRecord {
  const record = value as Partial<PasswordVerifierRecord> | null;
  return !!record &&
    record.algorithm === 'pbkdf2-sha256' &&
    typeof record.iterations === 'number' &&
    record.iterations >= 100_000 &&
    typeof record.saltB64 === 'string' &&
    typeof record.hashB64 === 'string';
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
