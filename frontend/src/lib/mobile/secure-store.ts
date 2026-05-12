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

interface DeepmarksSecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  getPendingNostrSignerRequest?(): Promise<PendingNostrSignerRequest | null>;
  completeNostrSignerRequest?(options: {
    requestId: string;
    result: string;
    id?: string;
    event?: string;
  }): Promise<void>;
  rejectNostrSignerRequest?(options: { requestId: string }): Promise<void>;
}

const NativeSecureStore = registerPlugin<DeepmarksSecureStorePlugin>('DeepmarksSecureStore');
const FALLBACK_PREFIX = 'deepmarks-secure-store-fallback:';

export type { PendingNostrSignerRequest };

export function isNativeSecureStoreAvailable(): boolean {
  return browser && Capacitor.isNativePlatform();
}

export async function secureGet(key: string): Promise<string | null> {
  if (isNativeSecureStoreAvailable()) {
    try {
      const { value } = await NativeSecureStore.get({ key });
      return value ?? null;
    } catch {
      // Fall through to the dev fallback so web preview stays usable.
    }
  }
  if (!browser) return null;
  try {
    return localStorage.getItem(FALLBACK_PREFIX + key);
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isNativeSecureStoreAvailable()) {
    await NativeSecureStore.set({ key, value });
    return;
  }
  if (!browser) return;
  localStorage.setItem(FALLBACK_PREFIX + key, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (isNativeSecureStoreAvailable()) {
    await NativeSecureStore.remove({ key });
    return;
  }
  if (!browser) return;
  localStorage.removeItem(FALLBACK_PREFIX + key);
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
