import { get } from 'svelte/store';
import { writable } from 'svelte/store';
import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip44,
  SimplePool,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { browser } from '$app/environment';
import { DEFAULT_RELAYS, userSettings } from '$lib/stores/user-settings';
import { loadMobileSignerAccount, type MobileSignerAccount } from './signer-account';
import { secureGet, secureSet } from './secure-store';

const NIP46_KIND = 24133;
const CONNECTIONS_KEY = 'deepmarks-mobile-signer-connections:v1';
const PRIVATE_ZAP_REQUEST_KIND = 9734;
const PRIVATE_ZAP_KIND = 9733;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export type Nip46TrustLevel = 'unset' | 'full' | 'medium' | 'low';

export interface MobileSignerConnection {
  id: string;
  clientPubkey: string;
  relays: string[];
  secret: string;
  perms: string[];
  trustLevel?: Nip46TrustLevel;
  name?: string;
  url?: string;
  image?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface MobileSignerStatus {
  foregroundAvailable: boolean;
  foregroundEnabled: boolean;
  running: boolean;
  accountPubkey: string | null;
  connectionCount: number;
  relayCount: number;
  lastMessage: string;
  lastError: string;
}

interface NativeNip46ServiceStatus {
  enabled: boolean;
  running: boolean;
  accountPubkey: string | null;
  connectionCount: number;
  relayCount: number;
  lastMessage: string;
  lastError: string;
}

export interface PendingNip46Approval {
  requestId: string;
  clientPubkey: string;
  clientName?: string;
  clientUrl?: string;
  clientImage?: string;
  accountPubkey: string;
  method: string;
  permission: string;
  permissions: string[];
  trustLevel: Nip46TrustLevel;
  createdAt: number;
  eventKind?: number;
  eventContent?: string;
}

interface DeepmarksNip46ServicePlugin {
  setEnabled(options: { enabled: boolean }): Promise<NativeNip46ServiceStatus>;
  refresh(): Promise<NativeNip46ServiceStatus>;
  status(): Promise<NativeNip46ServiceStatus>;
  getPendingApproval?(): Promise<PendingNip46Approval | null>;
  completeApproval?(options: {
    requestId: string;
    approved: boolean;
    trustLevel: Nip46TrustLevel;
  }): Promise<NativeNip46ServiceStatus>;
}

interface Nip46Request {
  id: string;
  method: string;
  params: string[];
}

export const mobileSignerStatus = writable<MobileSignerStatus>({
  foregroundAvailable: false,
  foregroundEnabled: false,
  running: false,
  accountPubkey: null,
  connectionCount: 0,
  relayCount: 0,
  lastMessage: '',
  lastError: '',
});

const NativeNip46Service = registerPlugin<DeepmarksNip46ServicePlugin>('DeepmarksNip46Service');

let pool: SimplePool | null = null;
let sub: { close: () => void } | null = null;
let runningKey = '';
let activeRelays: string[] = [];

export function parseNostrConnectUri(raw: string): Omit<MobileSignerConnection, 'id' | 'createdAt' | 'lastSeenAt'> {
  const url = new URL(raw.trim());
  if (url.protocol !== 'nostrconnect:') {
    throw new Error('expected a nostrconnect:// pairing URL');
  }
  const clientPubkey = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clientPubkey)) {
    throw new Error('nostrconnect URL is missing a hex client pubkey');
  }
  const relays = normalizeRelayList(url.searchParams.getAll('relay'));
  if (relays.length === 0) throw new Error('nostrconnect URL must include at least one relay');
  const secret = url.searchParams.get('secret') ?? '';
  if (!secret) throw new Error('nostrconnect URL is missing its secret');
  const metadata = parseNostrConnectMetadata(url.searchParams.get('metadata'));
  const perms = splitPerms(url.searchParams.get('perms') ?? metadata?.perms ?? '');
  return {
    clientPubkey,
    relays,
    secret,
    perms,
    name: cleanOptional(url.searchParams.get('name')) ?? metadata?.name,
    url: cleanOptional(url.searchParams.get('url')) ?? metadata?.url,
    image: cleanOptional(url.searchParams.get('image')) ?? metadata?.image,
  };
}

export async function loadMobileSignerConnections(): Promise<MobileSignerConnection[]> {
  const raw = await secureGet(CONNECTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const c = entry as Partial<MobileSignerConnection>;
      if (
        typeof c.id !== 'string' ||
        typeof c.clientPubkey !== 'string' ||
        !/^[0-9a-f]{64}$/.test(c.clientPubkey) ||
        !Array.isArray(c.relays) ||
        typeof c.secret !== 'string' ||
        !Array.isArray(c.perms) ||
        typeof c.createdAt !== 'number' ||
        typeof c.lastSeenAt !== 'number'
      ) return [];
      return [{
        id: c.id,
        clientPubkey: c.clientPubkey,
        relays: normalizeRelayList(c.relays),
        secret: c.secret,
        perms: c.perms.filter((p): p is string => typeof p === 'string'),
        trustLevel: normalizeTrustLevel(c.trustLevel),
        name: typeof c.name === 'string' ? c.name : undefined,
        url: typeof c.url === 'string' ? c.url : undefined,
        image: typeof c.image === 'string' ? c.image : undefined,
        createdAt: c.createdAt,
        lastSeenAt: c.lastSeenAt,
      }];
    });
  } catch {
    return [];
  }
}

export async function saveMobileSignerConnections(connections: MobileSignerConnection[]): Promise<void> {
  await secureSet(CONNECTIONS_KEY, JSON.stringify(connections));
}

export function mergeNip46PermissionLists(existing: string[], requested: string[]): string[] {
  const merged: string[] = [];
  for (const perm of [...existing, ...requested]) {
    const clean = typeof perm === 'string' ? perm.trim() : '';
    if (!clean || merged.includes(clean)) continue;
    merged.push(clean);
  }
  return merged;
}

function normalizeTrustLevel(value: unknown): Nip46TrustLevel {
  return value === 'full' || value === 'medium' || value === 'low' ? value : 'unset';
}

function existingTrustLevel(connections: MobileSignerConnection[], clientPubkey: string): Nip46TrustLevel {
  return normalizeTrustLevel(connections.find((c) => c.clientPubkey === clientPubkey)?.trustLevel);
}

export async function pairNostrConnect(rawUri: string): Promise<MobileSignerConnection> {
  const account = await requireAccount();
  const parsed = parseNostrConnectUri(rawUri);
  const now = Math.floor(Date.now() / 1000);
  const connections = await loadMobileSignerConnections();
  const connection: MobileSignerConnection = {
    ...parsed,
    id: parsed.clientPubkey,
    trustLevel: existingTrustLevel(connections, parsed.clientPubkey),
    createdAt: connections.find((c) => c.clientPubkey === parsed.clientPubkey)?.createdAt ?? now,
    lastSeenAt: now,
  };
  const next = [
    ...connections.filter((c) => c.clientPubkey !== connection.clientPubkey),
    connection,
  ];
  await saveMobileSignerConnections(next);
  await publishResponse(account, connection.clientPubkey, connection.relays, {
    id: randomId(),
    result: connection.secret,
  });
  mobileSignerStatus.update((s) => ({
    ...s,
    lastMessage: `paired ${connection.name || shortKey(connection.clientPubkey)}`,
    lastError: '',
  }));
  await restartMobileSignerService();
  return connection;
}

export async function removeMobileSignerConnection(clientPubkey: string): Promise<void> {
  const connections = await loadMobileSignerConnections();
  await saveMobileSignerConnections(connections.filter((c) => c.clientPubkey !== clientPubkey));
  await restartMobileSignerService();
}

export async function startMobileSignerInNativeShell(): Promise<void> {
  if (!browser || !Capacitor.isNativePlatform()) return;
  if (await refreshNativeForegroundSigner()) return;
  await startMobileSignerService();
}

export async function startMobileSignerService(): Promise<void> {
  if (await refreshNativeForegroundSigner()) return;

  const account = await loadMobileSignerAccount();
  const connections = await loadMobileSignerConnections();
  if (!account || connections.length === 0) {
    stopMobileSignerService();
    mobileSignerStatus.set({
      foregroundAvailable: isAndroidNative(),
      foregroundEnabled: false,
      running: false,
      accountPubkey: account?.pubkey ?? null,
      connectionCount: connections.length,
      relayCount: 0,
      lastMessage: account ? 'ready to pair' : 'add a mobile signer key',
      lastError: '',
    });
    return;
  }

  const relays = Array.from(new Set(connections.flatMap((c) => c.relays)));
  const key = `${account.pubkey}:${connections.map((c) => `${c.clientPubkey}:${c.relays.join(',')}`).sort().join('|')}`;
  if (pool && sub && runningKey === key) {
    mobileSignerStatus.update((s) => ({
      ...s,
      foregroundAvailable: isAndroidNative(),
      running: true,
      accountPubkey: account.pubkey,
      connectionCount: connections.length,
      relayCount: relays.length,
    }));
    return;
  }

  stopMobileSignerService();
  pool = new SimplePool();
  activeRelays = relays;
  runningKey = key;
  sub = pool.subscribeMany(
    relays,
    { kinds: [NIP46_KIND], '#p': [account.pubkey] },
    {
      onevent: (event: NostrEvent) => {
        void handleRequestEvent(event).catch((err) => {
          mobileSignerStatus.update((s) => ({ ...s, lastError: (err as Error).message }));
        });
      },
      oneose: () => undefined,
    },
  );
  mobileSignerStatus.set({
    foregroundAvailable: isAndroidNative(),
    foregroundEnabled: false,
    running: true,
    accountPubkey: account.pubkey,
    connectionCount: connections.length,
    relayCount: relays.length,
    lastMessage: `listening on ${relays.length} relay${relays.length === 1 ? '' : 's'}`,
    lastError: '',
  });
}

export async function setNativeForegroundSignerEnabled(enabled: boolean): Promise<void> {
  if (!nativeForegroundSignerAvailable()) {
    throw new Error('Android foreground signer is unavailable');
  }
  if (enabled) stopMobileSignerService();
  const status = await NativeNip46Service.setEnabled({ enabled });
  applyNativeStatus(status);
  if (enabled) scheduleNativeStatusRefresh();
  else await startMobileSignerService();
}

export async function refreshNativeForegroundSignerStatus(): Promise<void> {
  if (!nativeForegroundSignerAvailable()) return;
  applyNativeStatus(await NativeNip46Service.status());
}

export async function getPendingNip46Approval(): Promise<PendingNip46Approval | null> {
  if (!nativeForegroundSignerAvailable() || !NativeNip46Service.getPendingApproval) return null;
  const pending = await NativeNip46Service.getPendingApproval();
  if (!pending) return null;
  return {
    ...pending,
    permissions: Array.isArray(pending.permissions) ? pending.permissions.filter((p): p is string => typeof p === 'string') : [],
    trustLevel: normalizeTrustLevel(pending.trustLevel),
  };
}

export async function completePendingNip46Approval(options: {
  requestId: string;
  approved: boolean;
  trustLevel: Nip46TrustLevel;
}): Promise<void> {
  if (!nativeForegroundSignerAvailable() || !NativeNip46Service.completeApproval) {
    throw new Error('Android foreground signer approval is unavailable');
  }
  const status = await NativeNip46Service.completeApproval({
    requestId: options.requestId,
    approved: options.approved,
    trustLevel: normalizeTrustLevel(options.trustLevel),
  });
  applyNativeStatus(status);
  scheduleNativeStatusRefresh();
}

export async function restartMobileSignerService(): Promise<void> {
  stopMobileSignerService();
  await startMobileSignerService();
}

export function stopMobileSignerService(): void {
  sub?.close();
  sub = null;
  if (pool && activeRelays.length > 0) pool.close(activeRelays);
  pool = null;
  activeRelays = [];
  runningKey = '';
}

async function refreshNativeForegroundSigner(): Promise<boolean> {
  if (!nativeForegroundSignerAvailable()) return false;
  try {
    const status = await NativeNip46Service.refresh();
    applyNativeStatus(status);
    if (status.enabled) {
      scheduleNativeStatusRefresh();
      return true;
    }
  } catch (err) {
    mobileSignerStatus.update((s) => ({
      ...s,
      foregroundAvailable: true,
      lastError: (err as Error).message,
    }));
  }
  return false;
}

function applyNativeStatus(status: NativeNip46ServiceStatus): void {
  mobileSignerStatus.set({
    foregroundAvailable: true,
    foregroundEnabled: status.enabled,
    running: status.running,
    accountPubkey: status.accountPubkey,
    connectionCount: status.connectionCount,
    relayCount: status.relayCount,
    lastMessage: status.lastMessage,
    lastError: status.lastError,
  });
}

function scheduleNativeStatusRefresh(): void {
  if (!browser) return;
  window.setTimeout(() => {
    void refreshNativeForegroundSignerStatus();
  }, 500);
}

function nativeForegroundSignerAvailable(): boolean {
  return browser &&
    isAndroidNative() &&
    Capacitor.isPluginAvailable('DeepmarksNip46Service');
}

function isAndroidNative(): boolean {
  return browser && Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function executeMobileSignerMethod(
  method: string,
  params: string[],
  connection?: MobileSignerConnection,
): Promise<string> {
  const account = await requireAccount();
  if (connection && !permissionAllows(connection, method, params)) {
    throw new Error(`not authorized: ${method}`);
  }
  return withSecret(account.nsecHex, async (secret) => {
    switch (method) {
      case 'connect':
        return params[1] || 'ack';
      case 'get_public_key':
        return account.pubkey;
      case 'ping':
        return 'pong';
      case 'switch_relays':
        return JSON.stringify(connection?.relays ?? preferredRelayUrls());
      case 'sign_event':
        return JSON.stringify(await signEventTemplate(account, secret, parseSignEventParam(params[0])));
      case 'decrypt_zap_event':
      {
        assertParamCount(method, params, 1);
        return JSON.stringify(await decryptPrivateZapEvent(account, secret, params[0]!));
      }
      case 'nip04_encrypt':
      {
        assertParamCount(method, params, 2);
        const [peerPubkey, plaintext] = params as [string, string];
        return nip04.encrypt(secret, peerPubkey, plaintext);
      }
      case 'nip04_decrypt':
      {
        assertParamCount(method, params, 2);
        const [peerPubkey, ciphertext] = params as [string, string];
        return nip04.decrypt(secret, peerPubkey, ciphertext);
      }
      case 'nip44_encrypt':
      {
        assertParamCount(method, params, 2);
        const [peerPubkey, plaintext] = params as [string, string];
        return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, peerPubkey));
      }
      case 'nip44_decrypt':
      {
        assertParamCount(method, params, 2);
        const [peerPubkey, ciphertext] = params as [string, string];
        return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, peerPubkey));
      }
      default:
        throw new Error(`unsupported method: ${method}`);
    }
  });
}

async function handleRequestEvent(event: NostrEvent): Promise<void> {
  if (!verifyEvent(event)) return;
  const account = await requireAccount();
  const connections = await loadMobileSignerConnections();
  const connection = connections.find((c) => c.clientPubkey === event.pubkey);
  if (!connection) return;

  let request: Nip46Request | null = null;
  try {
    request = decryptRequest(account, event);
    let activeConnection = connection;
    if (request.method === 'connect') {
      activeConnection = await mergeConnectRequestedPermissions(connection, request.params[2]);
    }
    if (!permissionAllows(activeConnection, request.method, request.params)) {
      throw new Error(`not authorized: ${request.method}`);
    }
    const result = await executeMobileSignerMethod(request.method, request.params, activeConnection);
    await publishResponse(account, event.pubkey, activeConnection.relays, {
      id: request.id,
      result,
    });
    await touchConnection(activeConnection.clientPubkey);
    mobileSignerStatus.update((s) => ({
      ...s,
      lastMessage: `${request?.method ?? 'request'} signed for ${activeConnection.name || shortKey(activeConnection.clientPubkey)}`,
      lastError: '',
    }));
  } catch (err) {
    if (request) {
      await publishResponse(account, event.pubkey, connection.relays, {
        id: request.id,
        result: 'error',
        error: (err as Error).message,
      });
    }
    mobileSignerStatus.update((s) => ({ ...s, lastError: (err as Error).message }));
  }
}

async function mergeConnectRequestedPermissions(
  connection: MobileSignerConnection,
  requestedPerms: string | undefined,
): Promise<MobileSignerConnection> {
  const requested = splitPerms(requestedPerms ?? '');
  if (requested.length === 0) return connection;

  const connections = await loadMobileSignerConnections();
  let active = connection;
  let changed = false;
  const next = connections.map((candidate) => {
    if (candidate.clientPubkey !== connection.clientPubkey) return candidate;
    const perms = mergeNip46PermissionLists(candidate.perms, requested);
    if (perms.length === candidate.perms.length) {
      active = candidate;
      return candidate;
    }
    changed = true;
    active = { ...candidate, perms };
    return active;
  });
  if (changed) await saveMobileSignerConnections(next);
  return active;
}

function decryptRequest(account: MobileSignerAccount, event: NostrEvent): Nip46Request {
  return withSecretSync(account.nsecHex, (secret) => {
    const conversationKey = nip44.v2.utils.getConversationKey(secret, event.pubkey);
    const plaintext = nip44.v2.decrypt(event.content, conversationKey);
    const parsed = JSON.parse(plaintext) as Partial<Nip46Request>;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) throw new Error('request is missing id');
    if (typeof parsed.method !== 'string' || parsed.method.length === 0) throw new Error('request is missing method');
    if (!Array.isArray(parsed.params)) throw new Error('request params must be an array');
    for (const param of parsed.params) if (typeof param !== 'string') throw new Error('request params must be strings');
    return { id: parsed.id, method: parsed.method, params: parsed.params };
  });
}

async function publishResponse(
  account: MobileSignerAccount,
  clientPubkey: string,
  relays: string[],
  response: { id: string; result: string; error?: string },
): Promise<void> {
  const event = withSecretSync(account.nsecHex, (secret) => {
    const conversationKey = nip44.v2.utils.getConversationKey(secret, clientPubkey);
    const content = nip44.v2.encrypt(JSON.stringify(response), conversationKey);
    return finalizeEvent({
      kind: NIP46_KIND,
      content,
      tags: [['p', clientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    }, secret);
  });
  const publishPool = pool ?? new SimplePool();
  const relayList = normalizeRelayList(relays);
  await Promise.allSettled(publishPool.publish(relayList, event));
  if (!pool) publishPool.close(relayList);
}

function parseSignEventParam(raw: string | undefined): EventTemplate {
  if (!raw) throw new Error('sign_event expects an event template');
  const obj = JSON.parse(raw) as Partial<EventTemplate>;
  if (typeof obj.kind !== 'number' || !Number.isInteger(obj.kind) || obj.kind < 0 || obj.kind > 65535) {
    throw new Error('event.kind must be an integer');
  }
  const tags = obj.tags ?? [];
  if (!Array.isArray(tags)) throw new Error('event.tags must be an array');
  for (const tag of tags) {
    if (!Array.isArray(tag)) throw new Error('event.tags entries must be arrays');
    for (const value of tag) if (typeof value !== 'string') throw new Error('event.tags values must be strings');
  }
  if (obj.content !== undefined && typeof obj.content !== 'string') {
    throw new Error('event.content must be a string');
  }
  return {
    kind: obj.kind,
    content: obj.content ?? '',
    tags: tags as string[][],
    created_at: typeof obj.created_at === 'number' && Number.isInteger(obj.created_at)
      ? obj.created_at
      : Math.floor(Date.now() / 1000),
  };
}

async function signEventTemplate(
  account: MobileSignerAccount,
  secret: Uint8Array,
  template: EventTemplate,
): Promise<NostrEvent> {
  if (!isUnsignedPrivateZapTemplate(template)) return finalizeEvent(template, secret);

  const recipientPubkey = firstTagValue(template.tags, 'p');
  if (!recipientPubkey) throw new Error('private zap recipient is missing');
  const zappedEvent = firstTagValue(template.tags, 'e');
  const derivedSecret = privateZapDerivedSecret(account.nsecHex, zappedEvent ?? recipientPubkey, template.created_at);
  try {
    const publicTags = template.tags.filter((tag) => tag[0] !== 'anon');
    const privateEvent = finalizeEvent({
      kind: PRIVATE_ZAP_KIND,
      content: template.content,
      tags: publicTags,
      created_at: Math.floor(Date.now() / 1000),
    }, secret);
    const encrypted = await encryptPrivateZapMessage(JSON.stringify(privateEvent), derivedSecret, recipientPubkey);
    return finalizeEvent({
      kind: PRIVATE_ZAP_REQUEST_KIND,
      content: '',
      tags: [...publicTags, ['anon', encrypted]],
      created_at: template.created_at,
    }, derivedSecret);
  } finally {
    derivedSecret.fill(0);
  }
}

async function decryptPrivateZapEvent(
  account: MobileSignerAccount,
  secret: Uint8Array,
  raw: string,
): Promise<NostrEvent> {
  const event = JSON.parse(raw) as NostrEvent;
  if (event.kind !== PRIVATE_ZAP_REQUEST_KIND) throw new Error('event is not a zap request');
  const anon = firstTagValue(event.tags, 'anon');
  if (!anon) throw new Error('zap request is not private');
  const recipientPubkey = firstTagValue(event.tags, 'p');
  const zappedEvent = firstTagValue(event.tags, 'e');
  let privateKey = secret;
  let peerPubkey = event.pubkey;
  let derivedSecret: Uint8Array | null = null;
  if (recipientPubkey !== account.pubkey) {
    if (!recipientPubkey) throw new Error('private zap recipient is missing');
    derivedSecret = privateZapDerivedSecret(account.nsecHex, zappedEvent ?? recipientPubkey, event.created_at);
    if (getPublicKey(derivedSecret) !== event.pubkey) {
      derivedSecret.fill(0);
      throw new Error('private zap cannot be decrypted by this key');
    }
    privateKey = derivedSecret;
    peerPubkey = recipientPubkey;
  }
  try {
    const decrypted = await decryptPrivateZapMessage(anon, privateKey, peerPubkey);
    const privateEvent = JSON.parse(decrypted) as NostrEvent;
    if (privateEvent.kind !== PRIVATE_ZAP_KIND) throw new Error('decrypted event is not a private zap');
    if (!verifyEvent(privateEvent)) throw new Error('decrypted private zap signature is invalid');
    return privateEvent;
  } finally {
    derivedSecret?.fill(0);
  }
}

function isUnsignedPrivateZapTemplate(template: EventTemplate): boolean {
  return template.kind === PRIVATE_ZAP_REQUEST_KIND &&
    template.tags.some((tag) => tag.length > 1 && tag[0] === 'anon' && tag[1]?.trim() === '');
}

function privateZapDerivedSecret(nsecHex: string, id: string, createdAt: number): Uint8Array {
  return sha256(utf8Encoder.encode(`${nsecHex}${id}${createdAt}`));
}

async function encryptPrivateZapMessage(
  plaintext: string,
  privateKey: Uint8Array,
  peerPubkey: string,
): Promise<string> {
  const shared = sharedSecretX(privateKey, peerPubkey);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', asBufferSource(shared), 'AES-CBC', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: asBufferSource(iv) },
    key,
    asBufferSource(utf8Encoder.encode(plaintext)),
  ));
  return `${bech32Encode('pzap', encrypted)}_${bech32Encode('iv', iv)}`;
}

async function decryptPrivateZapMessage(
  payload: string,
  privateKey: Uint8Array,
  peerPubkey: string,
): Promise<string> {
  const [encryptedPart, ivPart] = payload.split('_');
  if (!encryptedPart || !ivPart) throw new Error('invalid private zap payload');
  const encrypted = bech32Decode(encryptedPart, 'pzap');
  const iv = bech32Decode(ivPart, 'iv');
  if (iv.length !== 16) throw new Error('invalid private zap iv');
  const shared = sharedSecretX(privateKey, peerPubkey);
  const key = await crypto.subtle.importKey('raw', asBufferSource(shared), 'AES-CBC', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: asBufferSource(iv) },
    key,
    asBufferSource(encrypted),
  );
  return utf8Decoder.decode(decrypted);
}

function sharedSecretX(privateKey: Uint8Array, peerPubkey: string): Uint8Array {
  const xOnly = hexToBytes(peerPubkey);
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(xOnly, 1);
  const shared = secp256k1.getSharedSecret(privateKey, compressed, true);
  return shared.slice(1, 33);
}

function bech32Encode(prefix: string, bytes: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(bytes), false);
}

function bech32Decode(value: string, expectedPrefix: string): Uint8Array {
  const decoded = bech32.decode(value as `${string}1${string}`, false);
  if (decoded.prefix !== expectedPrefix) throw new Error('unexpected private zap encoding');
  return Uint8Array.from(bech32.fromWords(decoded.words));
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy as BufferSource;
}

function firstTagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag.length > 1 && tag[0] === name)?.[1];
}

function permissionAllows(connection: MobileSignerConnection, method: string, params: string[]): boolean {
  if (connection.trustLevel === 'full') return true;
  if (method === 'connect' || method === 'get_public_key' || method === 'ping' || method === 'switch_relays') {
    return true;
  }
  const perms = new Set(connection.perms);
  if (method === 'sign_event') {
    const kind = signEventKind(params[0]);
    return perms.has('sign_event') || (kind !== null && perms.has(`sign_event:${kind}`));
  }
  return perms.has(method);
}

function signEventKind(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const event = JSON.parse(raw) as { kind?: unknown };
    return typeof event.kind === 'number' && Number.isInteger(event.kind) ? event.kind : null;
  } catch {
    return null;
  }
}

async function touchConnection(clientPubkey: string): Promise<void> {
  const connections = await loadMobileSignerConnections();
  const now = Math.floor(Date.now() / 1000);
  await saveMobileSignerConnections(connections.map((c) => (
    c.clientPubkey === clientPubkey ? { ...c, lastSeenAt: now } : c
  )));
}

async function requireAccount(): Promise<MobileSignerAccount> {
  const account = await loadMobileSignerAccount();
  if (!account) throw new Error('add a mobile signer key first');
  return account;
}

async function withSecret<T>(nsecHex: string, fn: (secret: Uint8Array) => Promise<T> | T): Promise<T> {
  const secret = hexToBytes(nsecHex);
  try {
    return await fn(secret);
  } finally {
    secret.fill(0);
  }
}

function withSecretSync<T>(nsecHex: string, fn: (secret: Uint8Array) => T): T {
  const secret = hexToBytes(nsecHex);
  try {
    return fn(secret);
  } finally {
    secret.fill(0);
  }
}

function normalizeRelayList(relays: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relays) {
    if (typeof raw !== 'string') continue;
    try {
      const url = new URL(raw.trim().replace(/\/$/, ''));
      if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue;
      if (!url.hostname.includes('.') && url.hostname !== 'localhost') continue;
      const normalized = url.toString().replace(/\/$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // Ignore malformed relay URLs.
    }
  }
  return out;
}

function preferredRelayUrls(): string[] {
  const settings = get(userSettings);
  const relays = settings.relays.filter((r) => r.read || r.write).map((r) => r.url);
  return relays.length > 0 ? relays : DEFAULT_RELAYS.map((r) => r.url);
}

function splitPerms(raw: string): string[] {
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

function cleanOptional(value: string | null): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

function parseNostrConnectMetadata(raw: string | null): {
  name?: string;
  url?: string;
  image?: string;
  perms?: string;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      url?: unknown;
      image?: unknown;
      perms?: unknown;
    };
    return {
      name: typeof parsed.name === 'string' ? cleanOptional(parsed.name) : undefined,
      url: typeof parsed.url === 'string' ? cleanOptional(parsed.url) : undefined,
      image: typeof parsed.image === 'string' ? cleanOptional(parsed.image) : undefined,
      perms: typeof parsed.perms === 'string' ? parsed.perms : undefined,
    };
  } catch {
    return null;
  }
}

function assertParamCount(method: string, params: string[], count: number): void {
  if (params.length !== count) throw new Error(`${method} expects ${count} params`);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
