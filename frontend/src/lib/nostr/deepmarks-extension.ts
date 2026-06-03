import { browser } from '$app/environment';

export interface DeepmarksExtensionNwcInfo {
  walletPubkey: string;
  relayUrl: string;
  lud16?: string;
  connectedAt: number;
}

export function deepmarksExtensionNwc() {
  if (!browser) return null;
  return window.deepmarks?.extension?.nwc ?? null;
}

export function deepmarksExtensionArchive() {
  if (!browser) return null;
  return window.deepmarks?.extension?.archive ?? null;
}

export async function loadExtensionNwc(): Promise<DeepmarksExtensionNwcInfo | null> {
  const nwc = deepmarksExtensionNwc();
  if (!nwc) throw new Error('Deepmarks extension NWC bridge not available');
  return validateNwcInfo(await nwc.get());
}

export async function saveExtensionNwc(uri: string): Promise<DeepmarksExtensionNwcInfo> {
  const nwc = deepmarksExtensionNwc();
  if (!nwc) throw new Error('Deepmarks extension NWC bridge not available');
  const info = validateNwcInfo(await nwc.connect(uri));
  if (!info) throw new Error('extension did not save NWC');
  return info;
}

export async function clearExtensionNwc(): Promise<void> {
  const nwc = deepmarksExtensionNwc();
  if (!nwc) throw new Error('Deepmarks extension NWC bridge not available');
  await nwc.clear();
}

export async function reconcileExtensionArchiveKeys(): Promise<boolean> {
  const archive = deepmarksExtensionArchive();
  if (!archive) return false;
  await archive.reconcile();
  return true;
}

function validateNwcInfo(value: unknown): DeepmarksExtensionNwcInfo | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('extension returned invalid NWC status');
  const v = value as Partial<DeepmarksExtensionNwcInfo>;
  if (
    typeof v.walletPubkey !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(v.walletPubkey) ||
    typeof v.relayUrl !== 'string' ||
    !/^wss?:\/\//i.test(v.relayUrl) ||
    typeof v.connectedAt !== 'number'
  ) {
    throw new Error('extension returned invalid NWC status');
  }
  return {
    walletPubkey: v.walletPubkey,
    relayUrl: v.relayUrl,
    lud16: typeof v.lud16 === 'string' ? v.lud16 : undefined,
    connectedAt: v.connectedAt,
  };
}
