import { get } from 'svelte/store';
import { writable } from 'svelte/store';
import {
  finalizeEvent,
  nip04,
  nip44,
  SimplePool,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { Capacitor } from '@capacitor/core';
import { browser } from '$app/environment';
import { DEFAULT_RELAYS, userSettings } from '$lib/stores/user-settings';
import { loadMobileSignerAccount, type MobileSignerAccount } from './signer-account';
import { secureGet, secureSet } from './secure-store';

const NIP46_KIND = 24133;
const CONNECTIONS_KEY = 'deepmarks-mobile-signer-connections:v1';

export interface MobileSignerConnection {
  id: string;
  clientPubkey: string;
  relays: string[];
  secret: string;
  perms: string[];
  name?: string;
  url?: string;
  image?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface MobileSignerStatus {
  running: boolean;
  accountPubkey: string | null;
  connectionCount: number;
  relayCount: number;
  lastMessage: string;
  lastError: string;
}

interface Nip46Request {
  id: string;
  method: string;
  params: string[];
}

export const mobileSignerStatus = writable<MobileSignerStatus>({
  running: false,
  accountPubkey: null,
  connectionCount: 0,
  relayCount: 0,
  lastMessage: '',
  lastError: '',
});

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
  const perms = splitPerms(url.searchParams.get('perms') ?? '');
  return {
    clientPubkey,
    relays,
    secret,
    perms,
    name: cleanOptional(url.searchParams.get('name')),
    url: cleanOptional(url.searchParams.get('url')),
    image: cleanOptional(url.searchParams.get('image')),
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

export async function pairNostrConnect(rawUri: string): Promise<MobileSignerConnection> {
  const account = await requireAccount();
  const parsed = parseNostrConnectUri(rawUri);
  const now = Math.floor(Date.now() / 1000);
  const connections = await loadMobileSignerConnections();
  const connection: MobileSignerConnection = {
    ...parsed,
    id: parsed.clientPubkey,
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
  await startMobileSignerService();
}

export async function startMobileSignerService(): Promise<void> {
  const account = await loadMobileSignerAccount();
  const connections = await loadMobileSignerConnections();
  if (!account || connections.length === 0) {
    stopMobileSignerService();
    mobileSignerStatus.set({
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
    running: true,
    accountPubkey: account.pubkey,
    connectionCount: connections.length,
    relayCount: relays.length,
    lastMessage: `listening on ${relays.length} relay${relays.length === 1 ? '' : 's'}`,
    lastError: '',
  });
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
        return JSON.stringify(finalizeEvent(parseSignEventParam(params[0]), secret));
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
    if (!permissionAllows(connection, request.method, request.params)) {
      throw new Error(`not authorized: ${request.method}`);
    }
    const result = await executeMobileSignerMethod(request.method, request.params, connection);
    await publishResponse(account, event.pubkey, connection.relays, {
      id: request.id,
      result,
    });
    await touchConnection(connection.clientPubkey);
    mobileSignerStatus.update((s) => ({
      ...s,
      lastMessage: `${request?.method ?? 'request'} signed for ${connection.name || shortKey(connection.clientPubkey)}`,
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

function permissionAllows(connection: MobileSignerConnection, method: string, params: string[]): boolean {
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

function assertParamCount(method: string, params: string[], count: number): void {
  if (params.length !== count) throw new Error(`${method} expects ${count} params`);
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
