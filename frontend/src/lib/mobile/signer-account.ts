import { getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { secureGet, secureRemove, secureSet } from './secure-store';

const ACCOUNT_KEY = 'deepmarks-mobile-signer-account:v1';

export interface MobileSignerAccount {
  schemaVersion: 1;
  pubkey: string;
  nsecHex: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeNsecInput(input: string): string {
  const value = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'nsec') throw new Error('expected nsec1 secret key');
    return bytesToHex(decoded.data as Uint8Array);
  }
  throw new Error('enter an nsec1 key or 64-character hex secret');
}

export function pubkeyFromNsecHex(nsecHex: string): string {
  const secret = hexToBytes(nsecHex);
  try {
    return getPublicKey(secret);
  } finally {
    secret.fill(0);
  }
}

export async function loadMobileSignerAccount(): Promise<MobileSignerAccount | null> {
  const raw = await secureGet(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MobileSignerAccount>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.pubkey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.pubkey) ||
      typeof parsed.nsecHex !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.nsecHex) ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.updatedAt !== 'number'
    ) {
      await secureRemove(ACCOUNT_KEY);
      return null;
    }
    if (pubkeyFromNsecHex(parsed.nsecHex) !== parsed.pubkey) {
      await secureRemove(ACCOUNT_KEY);
      return null;
    }
    return parsed as MobileSignerAccount;
  } catch {
    await secureRemove(ACCOUNT_KEY);
    return null;
  }
}

export async function saveMobileSignerNsec(input: string): Promise<MobileSignerAccount> {
  const nsecHex = normalizeNsecInput(input);
  const now = Math.floor(Date.now() / 1000);
  const existing = await loadMobileSignerAccount();
  const account: MobileSignerAccount = {
    schemaVersion: 1,
    pubkey: pubkeyFromNsecHex(nsecHex),
    nsecHex,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await secureSet(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

export async function clearMobileSignerAccount(): Promise<void> {
  await secureRemove(ACCOUNT_KEY);
}
