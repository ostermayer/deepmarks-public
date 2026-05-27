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
  requesterPackage?: string;
  requesterName?: string;
}

type AndroidSignerTrustLevel = 'full' | 'medium' | 'low';
type ExternalAndroidSignerMethod =
  | 'get_public_key'
  | 'sign_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt'
  | 'decrypt_zap_event';

export interface ExternalAndroidSignerAccount {
  pubkey: string;
  packageName: string;
  appName?: string;
}

export interface ExternalAndroidSignerApp {
  packageName: string;
  appName?: string;
}

export interface ExternalAndroidSignerResult {
  result: string;
  event?: string;
  id?: string;
  packageName?: string;
  appName?: string;
}

export interface AndroidSignerTrustRecord {
  appId: string;
  appName?: string;
  requesterName?: string;
  requesterPackage?: string;
  level: AndroidSignerTrustLevel;
  updatedAt?: number | string;
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
  createdAtMs?: string;
  /** Hex pubkey that was active when the native share sheet created
   *  this pending save. Native save/drain paths use this as an account
   *  guard so a stale mobile-signer key can never publish a bookmark
   *  under the wrong Nostr identity. Older pending shares may omit it. */
  ownerPubkey?: string;
  /** Set to "1" by the native share sheet when it has already signed
   *  and POSTed the kind:39701 to /publish itself. The share-drain
   *  on next foreground reads the field, skips the relay publish,
   *  and just updates the local own-bookmarks store + archive
   *  queue. Public-visibility shares only — private bookmarks
   *  always come through the publish path because they need a
   *  chunked-set rewrite. */
  published?: string;
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
  setNostrSignerTrust?(options: {
    appId: string;
    level: AndroidSignerTrustLevel;
    requesterName?: string;
  }): Promise<void>;
  removeNostrSignerTrust?(options: { appId: string }): Promise<void>;
  listNostrSignerTrust?(): Promise<{ permissions: AndroidSignerTrustRecord[] }>;
  listAndroidSigners?(): Promise<{ signers: ExternalAndroidSignerApp[] }>;
  connectAndroidSigner?(options?: {
    packageName?: string;
    permissions?: string;
  }): Promise<ExternalAndroidSignerAccount>;
  callAndroidSigner?(options: {
    packageName: string;
    type: ExternalAndroidSignerMethod;
    content: string;
    currentUser?: string;
    pubkey?: string;
    id?: string;
    returnType?: string;
  }): Promise<ExternalAndroidSignerResult>;
  getPendingSharedBookmark?(options?: { id?: string }): Promise<{ bookmark: PendingSharedBookmark | null }>;
  removePendingSharedBookmark?(options: { id: string }): Promise<void>;
  writeUserTags?(options: { tags: string[] }): Promise<void>;
  writeShareDefaults?(options: {
    defaultVisibility: 'private' | 'public';
    defaultReadLater: boolean;
    defaultTags: string[];
    activePubkey?: string;
  }): Promise<void>;
}

const NativeSecureStore = registerPlugin<DeepmarksSecureStorePlugin>('DeepmarksSecureStore');
const FALLBACK_PREFIX = 'deepmarks-secure-store-fallback:';
const PLUGIN_NAME = 'DeepmarksSecureStore';
let nativeBridgeUnavailable = false;

export type { PendingNostrSignerRequest };

export function isNativeSecureStoreAvailable(): boolean {
  return (
    browser &&
    isNativeRuntime() &&
    !nativeBridgeUnavailable &&
    Capacitor.isPluginAvailable(PLUGIN_NAME)
  );
}

function isNativeRuntime(): boolean {
  return browser && Capacitor.isNativePlatform();
}

function secureStoreUnavailableError(): Error {
  return new Error('secure storage is unavailable. update Deepmarks and try again.');
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
      if (!disableNativeBridgeIfNeeded(error)) throw error;
    }
  }
  if (isNativeRuntime()) {
    // Never read signer/app-lock secrets from WebView localStorage on
    // native. Older broken builds may have written fallback entries;
    // treating them as absent forces a safer re-login path.
    return null;
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
  if (isNativeRuntime()) {
    fallbackRemove(key);
    throw secureStoreUnavailableError();
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
  if (isNativeRuntime()) {
    fallbackRemove(key);
    return;
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

export async function setNostrSignerTrust(options: {
  appId: string;
  level: AndroidSignerTrustLevel;
  requesterName?: string;
}): Promise<void> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.setNostrSignerTrust
  ) {
    return;
  }
  await NativeSecureStore.setNostrSignerTrust(options);
}

export async function removeNostrSignerTrust(appId: string): Promise<void> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.removeNostrSignerTrust
  ) {
    return;
  }
  await NativeSecureStore.removeNostrSignerTrust({ appId });
}

export async function listNostrSignerTrust(): Promise<AndroidSignerTrustRecord[]> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.listNostrSignerTrust
  ) {
    return [];
  }
  const result = await NativeSecureStore.listNostrSignerTrust();
  return Array.isArray(result.permissions) ? result.permissions : [];
}

export async function connectAndroidSigner(options: {
  packageName?: string;
  permissions?: string;
} = {}): Promise<ExternalAndroidSignerAccount> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.connectAndroidSigner
  ) {
    throw new Error('Android signer connection is unavailable');
  }
  const result = await NativeSecureStore.connectAndroidSigner({
    packageName: options.packageName ?? '',
    permissions: options.permissions ?? '',
  });
  if (!result.pubkey || !result.packageName) {
    throw new Error('Android signer returned an invalid account');
  }
  return result;
}

export async function listAndroidSigners(): Promise<ExternalAndroidSignerApp[]> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.listAndroidSigners
  ) {
    return [];
  }
  const result = await NativeSecureStore.listAndroidSigners();
  return Array.isArray(result.signers) ? result.signers : [];
}

export async function callAndroidSigner(options: {
  packageName: string;
  type: ExternalAndroidSignerMethod;
  content: string;
  currentUser?: string;
  pubkey?: string;
  id?: string;
  returnType?: string;
}): Promise<ExternalAndroidSignerResult> {
  if (
    !isNativeSecureStoreAvailable() ||
    Capacitor.getPlatform() !== 'android' ||
    !NativeSecureStore.callAndroidSigner
  ) {
    throw new Error('Android signer bridge is unavailable');
  }
  const result = await NativeSecureStore.callAndroidSigner(options);
  if (!result || typeof result.result !== 'string') {
    throw new Error('Android signer returned an invalid response');
  }
  return result;
}

export async function getPendingSharedBookmark(id?: string): Promise<PendingSharedBookmark | null> {
  if (
    !isNativeSecureStoreAvailable() ||
    !['ios', 'android'].includes(Capacitor.getPlatform()) ||
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

export async function writeUserTagsToAppGroup(tags: string[]): Promise<void> {
  // No-op on web. Native share sheets consume this tag list for local
  // autocomplete without needing to open the WebView.
  if (
    !isNativeSecureStoreAvailable() ||
    !['ios', 'android'].includes(Capacitor.getPlatform()) ||
    !NativeSecureStore.writeUserTags
  ) {
    return;
  }
  try {
    await NativeSecureStore.writeUserTags({ tags: tags.slice(0, 400) });
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
  }
}

export async function writeShareDefaultsToAppGroup(options: {
  defaultVisibility: 'private' | 'public';
  defaultReadLater: boolean;
  defaultTags: string[];
  activePubkey?: string | null;
}): Promise<void> {
  if (
    !isNativeSecureStoreAvailable() ||
    !['ios', 'android'].includes(Capacitor.getPlatform()) ||
    !NativeSecureStore.writeShareDefaults
  ) {
    return;
  }
  try {
    await NativeSecureStore.writeShareDefaults({
      defaultVisibility: options.defaultVisibility,
      defaultReadLater: options.defaultReadLater,
      defaultTags: options.defaultTags.slice(0, 40),
      activePubkey: options.activePubkey ?? '',
    });
  } catch (error) {
    disableNativeBridgeIfNeeded(error);
  }
}

export async function removePendingSharedBookmark(id: string): Promise<void> {
  if (
    !id ||
    !isNativeSecureStoreAvailable() ||
    !['ios', 'android'].includes(Capacitor.getPlatform()) ||
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
