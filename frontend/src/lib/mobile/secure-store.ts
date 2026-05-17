import { browser } from '$app/environment';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface PendingNostrSignerRequest {
  requestId: string;
  rawUrl: string;
  type: string;
  content: string;
  id?: string;
  pubkey?: string;
  currentUser?: string;
  permissions?: string;
  returnType?: string;
  callbackUrl?: string;
}

export interface PendingSharedBookmark {
  id: string;
  url: string;
  title?: string;
  description?: string;
  tags?: string;
  readLater?: string;
  visibility?: 'default' | 'public' | 'private' | string;
  autosave?: string;
  createdAt?: string;
}

interface DeepmarksSecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  canAuthenticateBiometric?(): Promise<{ available: boolean; biometryType?: string }>;
  authenticateBiometric?(options: { reason: string }): Promise<{ authenticated: boolean }>;
  getPendingNostrSignerRequest?(): Promise<PendingNostrSignerRequest | null>;
  completeNostrSignerRequest?(options: {
    requestId: string;
    result: string;
    id?: string;
    event?: string;
  }): Promise<void>;
  rejectNostrSignerRequest?(options: { requestId: string }): Promise<void>;
  getPendingSharedBookmark?(options?: { id?: string }): Promise<{ bookmark: PendingSharedBookmark | null }>;
  removePendingSharedBookmark?(options: { id: string }): Promise<void>;
}

const NativeSecureStore = registerPlugin<DeepmarksSecureStorePlugin>('DeepmarksSecureStore');
const FALLBACK_PREFIX = 'deepmarks-secure-store-fallback:';
const PLUGIN_NAME = 'DeepmarksSecureStore';
let nativeBridgeUnavailable = false;

export type { PendingNostrSignerRequest };

export function isNativeSecureStoreAvailable(): boolean {
  return (
    browser &&
    Capacitor.isNativePlatform() &&
    !nativeBridgeUnavailable &&
    Capacitor.isPluginAvailable(PLUGIN_NAME)
  );
}

function isNativeBridgeUnavailable(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    code === 'UNIMPLEMENTED' ||
    /plugin is not implemented|not implemented on|not available on|DeepmarksSecureStore/i.test(message)
  );
}

function disableNativeBridgeIfNeeded(error: unknown): boolean {
  if (!isNativeBridgeUnavailable(error)) return false;
  nativeBridgeUnavailable = true;
  return true;
}

function fallbackGet(key: string): string | null {
  if (!browser) return null;
  try {
    return localStorage.getItem(FALLBACK_PREFIX + key);
  } catch {
    return null;
  }
}

function fallbackSet(key: string, value: string): void {
  if (!browser) return;
  localStorage.setItem(FALLBACK_PREFIX + key, value);
}

function fallbackRemove(key: string): void {
  if (!browser) return;
  localStorage.removeItem(FALLBACK_PREFIX + key);
}

export async function secureGet(key: string): Promise<string | null> {
  if (isNativeSecureStoreAvailable()) {
    try {
      const { value } = await NativeSecureStore.get({ key });
      return value ?? null;
    } catch (error) {
      disableNativeBridgeIfNeeded(error);
      // Fall through to the fallback so web preview and older native
      // builds stay usable while the fixed bridge is installed.
    }
  }
  return fallbackGet(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isNativeSecureStoreAvailable()) {
    try {
      await NativeSecureStore.set({ key, value });
      return;
    } catch (error) {
      if (!disableNativeBridgeIfNeeded(error)) throw error;
    }
  }
  fallbackSet(key, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (isNativeSecureStoreAvailable()) {
    try {
      await NativeSecureStore.remove({ key });
      return;
    } catch (error) {
      if (!disableNativeBridgeIfNeeded(error)) throw error;
    }
  }
  fallbackRemove(key);
}

export async function canAuthenticateBiometric(): Promise<{ available: boolean; biometryType: string }> {
  if (!isNativeSecureStoreAvailable() || !NativeSecureStore.canAuthenticateBiometric) {
    return { available: false, biometryType: '' };
  }
  try {
    const result = await NativeSecureStore.canAuthenticateBiometric();
    return { available: result.available === true, biometryType: result.biometryType ?? '' };
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
    return { available: false, biometryType: '' };
  }
}

export async function authenticateBiometric(reason: string): Promise<void> {
  if (!isNativeSecureStoreAvailable() || !NativeSecureStore.authenticateBiometric) {
    throw new Error('biometric unlock is unavailable');
  }
  let result: { authenticated: boolean };
  try {
    result = await NativeSecureStore.authenticateBiometric({ reason });
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
    throw error;
  }
  if (!result.authenticated) throw new Error('biometric unlock failed');
}

export async function getPendingNostrSignerRequest(): Promise<PendingNostrSignerRequest | null> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.getPendingNostrSignerRequest
  ) {
    return null;
  }
  return NativeSecureStore.getPendingNostrSignerRequest();
}

export async function completeNostrSignerRequest(options: {
  requestId: string;
  result: string;
  id?: string;
  event?: string;
}): Promise<void> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.completeNostrSignerRequest
  ) {
    throw new Error('Android signer result bridge is unavailable');
  }
  await NativeSecureStore.completeNostrSignerRequest(options);
}

export async function rejectNostrSignerRequest(requestId: string): Promise<void> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.rejectNostrSignerRequest
  ) {
    return;
  }
  await NativeSecureStore.rejectNostrSignerRequest({ requestId });
}

export async function getPendingSharedBookmark(id?: string): Promise<PendingSharedBookmark | null> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'ios' ||
    !NativeSecureStore.getPendingSharedBookmark
  ) {
    return null;
  }
  try {
    const result = await NativeSecureStore.getPendingSharedBookmark(id ? { id } : undefined);
    return result.bookmark ?? null;
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
    return null;
  }
}

export async function removePendingSharedBookmark(id: string): Promise<void> {
  if (
    !id ||
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'ios' ||
    !NativeSecureStore.removePendingSharedBookmark
  ) {
    return;
  }
  try {
    await NativeSecureStore.removePendingSharedBookmark({ id });
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
  }
}
