import { get, writable } from 'svelte/store';
import {
  authenticateBiometric,
  canAuthenticateBiometric,
  isNativeSecureStoreAvailable,
  secureGet,
  secureRemove,
  secureSet,
} from './secure-store';
import {
  createPasswordVerifier,
  isPasswordVerifierRecord,
  verifyPassword,
  type PasswordVerifierRecord,
} from '$lib/crypto/password-verifier';

const APP_LOCK_KEY = 'deepmarks-mobile-app-lock:v1';

export type MobileAppLockMode = 'off' | 'pin' | 'password' | 'biometric';

interface SecretLockRecord {
  schemaVersion: 1;
  mode: 'pin' | 'password';
  verifier: PasswordVerifierRecord;
  createdAt: number;
  updatedAt: number;
}

interface BiometricLockRecord {
  schemaVersion: 1;
  mode: 'biometric';
  createdAt: number;
  updatedAt: number;
}

type AppLockRecord = SecretLockRecord | BiometricLockRecord;

interface MobileAppLockState {
  initialized: boolean;
  available: boolean;
  enabled: boolean;
  mode: MobileAppLockMode;
  locked: boolean;
  busy: boolean;
  error: string;
  biometricAvailable: boolean;
  biometricType: string;
}

const initialState: MobileAppLockState = {
  initialized: false,
  available: false,
  enabled: false,
  mode: 'off',
  locked: false,
  busy: false,
  error: '',
  biometricAvailable: false,
  biometricType: '',
};

export const mobileAppLock = writable<MobileAppLockState>(initialState);

let initPromise: Promise<void> | null = null;

export function initMobileAppLock(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = refreshMobileAppLock({ lockOnEnabled: true });
  return initPromise;
}

export async function refreshMobileAppLock(options: { lockOnEnabled?: boolean } = {}): Promise<void> {
  if (!isNativeSecureStoreAvailable()) {
    mobileAppLock.set({ ...initialState, initialized: true });
    return;
  }

  const [record, biometric] = await Promise.all([
    readRecord(),
    canAuthenticateBiometric().catch(() => ({ available: false, biometryType: '' })),
  ]);
  const current = get(mobileAppLock);
  const enabled = !!record;
  mobileAppLock.set({
    initialized: true,
    available: true,
    enabled,
    mode: record?.mode ?? 'off',
    locked: enabled ? (options.lockOnEnabled === true ? true : current.locked) : false,
    busy: false,
    error: '',
    biometricAvailable: biometric.available,
    biometricType: biometric.biometryType || 'biometric',
  });
}

export async function setMobileAppPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (!/^\d{4,12}$/.test(trimmed)) throw new Error('PIN must be 4 to 12 digits');
  await writeSecretRecord('pin', trimmed);
}

export async function setMobileAppPassword(password: string): Promise<void> {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  await writeSecretRecord('password', password);
}

export async function setMobileAppBiometricLock(): Promise<void> {
  const biometric = await canAuthenticateBiometric();
  if (!biometric.available) throw new Error('biometric unlock is not available on this device');
  const existing = await readRecord();
  const now = Math.floor(Date.now() / 1000);
  const record: BiometricLockRecord = {
    schemaVersion: 1,
    mode: 'biometric',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await secureSet(APP_LOCK_KEY, JSON.stringify(record));
  await refreshMobileAppLock({ lockOnEnabled: false });
}

export async function clearMobileAppLock(): Promise<void> {
  await secureRemove(APP_LOCK_KEY);
  await refreshMobileAppLock({ lockOnEnabled: false });
}

export function lockMobileApp(): void {
  const current = get(mobileAppLock);
  if (!current.available || !current.enabled) return;
  mobileAppLock.update((state) => ({ ...state, locked: true, error: '' }));
}

export async function unlockMobileApp(secret = ''): Promise<void> {
  const record = await readRecord();
  if (!record) {
    await refreshMobileAppLock({ lockOnEnabled: false });
    return;
  }
  mobileAppLock.update((state) => ({ ...state, busy: true, error: '' }));
  try {
    if (record.mode === 'biometric') {
      await authenticateBiometric('Unlock Deepmarks');
    } else {
      const ok = await verifyPassword(record.mode === 'pin' ? secret.trim() : secret, record.verifier);
      if (!ok) throw new Error(record.mode === 'pin' ? 'PIN is incorrect' : 'password is incorrect');
    }
    mobileAppLock.update((state) => ({ ...state, locked: false, busy: false, error: '' }));
  } catch (e) {
    mobileAppLock.update((state) => ({
      ...state,
      busy: false,
      error: (e as Error).message || 'unlock failed',
    }));
    throw e;
  }
}

async function writeSecretRecord(mode: 'pin' | 'password', secret: string): Promise<void> {
  const existing = await readRecord();
  const now = Math.floor(Date.now() / 1000);
  const record: SecretLockRecord = {
    schemaVersion: 1,
    mode,
    verifier: await createPasswordVerifier(secret),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await secureSet(APP_LOCK_KEY, JSON.stringify(record));
  await refreshMobileAppLock({ lockOnEnabled: false });
}

async function readRecord(): Promise<AppLockRecord | null> {
  const raw = await secureGet(APP_LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AppLockRecord>;
    const hasBase =
      parsed.schemaVersion === 1 &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.updatedAt === 'number';
    if (!hasBase) throw new Error('invalid app lock record');
    if (parsed.mode === 'biometric') return parsed as BiometricLockRecord;
    if (
      (parsed.mode === 'pin' || parsed.mode === 'password') &&
      isPasswordVerifierRecord((parsed as Partial<SecretLockRecord>).verifier)
    ) {
      return parsed as SecretLockRecord;
    }
    throw new Error('invalid app lock record');
  } catch {
    await secureRemove(APP_LOCK_KEY);
    return null;
  }
}
