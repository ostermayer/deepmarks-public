import { secureGet, secureRemove, secureSet } from './secure-store';
import {
  createPasswordVerifier,
  isPasswordVerifierRecord,
  verifyPassword,
  type PasswordVerifierRecord,
} from '$lib/crypto/password-verifier';

const REVEAL_PASSWORD_KEY = 'deepmarks-mobile-reveal-password:v1';

interface RevealPasswordRecord {
  schemaVersion: 1;
  verifier: PasswordVerifierRecord;
  createdAt: number;
  updatedAt: number;
}

export async function hasMobileRevealPassword(): Promise<boolean> {
  return (await readRecord()) !== null;
}

export async function setMobileRevealPassword(password: string): Promise<void> {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const verifier = await createPasswordVerifier(password);
  const existing = await readRecord();
  const now = Math.floor(Date.now() / 1000);
  const record: RevealPasswordRecord = {
    schemaVersion: 1,
    verifier,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await secureSet(REVEAL_PASSWORD_KEY, JSON.stringify(record));
}

export async function verifyMobileRevealPassword(password: string): Promise<boolean> {
  const record = await readRecord();
  if (!record) return false;
  return verifyPassword(password, record.verifier);
}

export async function clearMobileRevealPassword(): Promise<void> {
  await secureRemove(REVEAL_PASSWORD_KEY);
}

async function readRecord(): Promise<RevealPasswordRecord | null> {
  const raw = await secureGet(REVEAL_PASSWORD_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RevealPasswordRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      !isPasswordVerifierRecord(parsed.verifier) ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      await clearMobileRevealPassword();
      return null;
    }
    return parsed as RevealPasswordRecord;
  } catch {
    await clearMobileRevealPassword();
    return null;
  }
}
