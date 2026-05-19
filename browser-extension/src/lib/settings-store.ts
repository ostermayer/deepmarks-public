// User-tunable settings. Cross-client preferences are cached locally
// and synced through api.deepmarks.org/account/settings; device-local
// security grants (savedLogins) never leave this browser.
//
// Defaults match the deepmarks.org web app's defaults so cross-device
// behavior is consistent.

import { buildNip98AuthHeader } from './nip98.js';

const KEY = 'deepmarks-settings';
const API_BASE = 'https://api.deepmarks.org';

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export type SavedLoginMethod =
  | 'getPublicKey'
  | 'getRelays'
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt'
  | 'webln.enable'
  | 'webln.getInfo';

export interface SavedLoginScope {
  method: SavedLoginMethod;
  /** Required for signEvent grants; absent for method-only grants. */
  kind?: number;
}

export interface SavedLogin extends SavedLoginScope {
  /** Origin like `https://stacker.news` */
  origin: string;
  /** Unix seconds — when the user granted "Forever". */
  grantedAt: number;
  /** Last time we used the grant — UI shows "last used Nd ago". */
  lastUsedAt: number;
}

export type BookmarkVisibility = 'private' | 'public';
export type PublishMode = 'deepmarks' | 'direct';

export interface Settings {
  schemaVersion: number;
  /** Last accepted server settings timestamp. */
  syncedAt: number;
  relays: RelayConfig[];
  defaultTags: string[];
  archiveDefault: boolean;
  /** True only after the user manually changes the archive-default
   *  toggle. Lifetime users auto-start with archiveDefault on until
   *  they explicitly turn it off. */
  archiveDefaultManualOverride: boolean;
  /** Initial visibility for new bookmarks. The Add screen pre-selects
   *  this; user can flip per-bookmark. Default: private (matches the
   *  "your data, your call" framing — most people don't want every
   *  saved page to be a public broadcast). */
  defaultVisibility: BookmarkVisibility;
  /** Device-local publish route. Default keeps the user's browser IP
   *  off public relay connections by posting signed events to
   *  api.deepmarks.org/publish for server-side fanout. */
  publishMode: PublishMode;
  /** User-owned Blossom servers to mirror archives to in addition to
   *  Deepmarks' operator defaults. Normalized https origins. */
  backupBlossomServers: string[];
  savedLogins: SavedLogin[];
}

const CURRENT_SCHEMA_VERSION = 5;
const DAMUS_RELAY = 'wss://relay.damus.io';
const LEGACY_DEFAULT_RELAY_URLS = [
  'wss://relay.deepmarks.org',
  DAMUS_RELAY,
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// Default relays match frontend/src/lib/config.ts. Keeping them in
// sync means a user signed in on the web + the extension publishes to
// the same set on both surfaces.
export const DEFAULT_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.deepmarks.org', read: true,  write: true  },
  { url: 'wss://nos.lol',             read: true,  write: true  },
  { url: 'wss://relay.primal.net',    read: true,  write: true  },
];

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  syncedAt: 0,
  relays: DEFAULT_RELAYS,
  defaultTags: ['toread'],
  archiveDefault: false,
  archiveDefaultManualOverride: false,
  defaultVisibility: 'private',
  publishMode: 'deepmarks',
  backupBlossomServers: [],
  savedLogins: [],
};

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  const value = raw[KEY] as Partial<Settings> | undefined;
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  // Merge with defaults so newly-added fields pick up sensible values
  // for users who installed before that field existed.
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    relays: normalizeRelays(value.relays),
    defaultTags: normalizeTags(value.defaultTags),
    defaultVisibility: value.defaultVisibility === 'public' ? 'public' : 'private',
    publishMode: value.publishMode === 'direct' ? 'direct' : 'deepmarks',
    archiveDefaultManualOverride: value.archiveDefaultManualOverride === true,
    backupBlossomServers: Array.isArray(value.backupBlossomServers)
      ? normalizeBlossom(value.backupBlossomServers)
      : DEFAULT_SETTINGS.backupBlossomServers,
    savedLogins: normalizeSavedLogins(value.savedLogins),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    syncedAt: typeof value.syncedAt === 'number' ? value.syncedAt : 0,
  };
}

export async function setSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: { ...next, schemaVersion: CURRENT_SCHEMA_VERSION } });
}

// Single-flight writer chain: every mutating operation queues onto
// this promise so concurrent patches (popup flipping a toggle while
// the background is appending a savedLogin) can't lost-update each
// other. Each task re-reads the latest state before applying its
// mutation, then writes atomically.
let writeChain: Promise<unknown> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  // Catch so a thrown task doesn't poison the chain for the next caller.
  writeChain = next.catch(() => undefined);
  return next;
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  return withWriteLock(async () => {
    const current = await getSettings();
    const merged: Settings = { ...current, ...patch };
    await setSettings(merged);
    return merged;
  });
}

export interface SyncedSettings {
  schemaVersion: 1;
  updatedAt: number;
  relays: RelayConfig[];
  defaultTags: string[];
  archiveAllByDefault: boolean;
  archiveDefaultManualOverride: boolean;
  defaultVisibility: BookmarkVisibility;
  backupBlossomServers: string[];
}

export async function syncSettingsFromServer(nsecHex: string): Promise<Settings> {
  const url = `${API_BASE}/account/settings`;
  const auth = await buildNip98AuthHeader(url, 'GET', nsecHex);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`settings sync failed: ${res.status}`);
  const remote = normalizeSyncedSettings(await res.json());
  return mutateSettings((current) => {
    if (remote.updatedAt < current.syncedAt) return current;
    return mergeSyncedIntoLocal(current, remote);
  });
}

export async function pushSettingsToServer(nsecHex: string, settings: Settings): Promise<Settings> {
  const url = `${API_BASE}/account/settings`;
  const body = JSON.stringify(toSyncedPayload(settings));
  const auth = await buildNip98AuthHeader(url, 'PUT', nsecHex, body);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`settings save failed: ${res.status}`);
  const remote = normalizeSyncedSettings(await res.json());
  return mutateSettings((current) => mergeSyncedIntoLocal(current, remote));
}

async function mutateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  return withWriteLock(async () => {
    const current = await getSettings();
    const next = fn(current);
    await setSettings(next);
    return next;
  });
}

const DEEPMARKS_RELAY = 'wss://relay.deepmarks.org';

/** Device-local publish route. This is deliberately not synced through
 *  /account/settings; a desktop browser can publish directly while a
 *  mobile or work profile keeps the privacy-preserving default. */
export async function getPublishMode(): Promise<PublishMode> {
  return (await getSettings()).publishMode;
}

/** Convenience: write-enabled relays from the extension list. Direct
 *  publish mode uses these. Server-mediated mode ignores them for the
 *  first hop and lets api.deepmarks.org fan out via NIP-65. */
export async function getWriteRelays(): Promise<string[]> {
  const { relays } = await getSettings();
  const out = relays.filter((r) => r.write).map((r) => r.url);
  return out.length > 0 ? out : [DEEPMARKS_RELAY];
}

/** Merge a freshly-imported NIP-65 relay list into settings.relays.
 *  Behavior:
 *    - URLs already present keep their existing read/write flags
 *      (the user may have customized them).
 *    - New URLs get their NIP-65 read/write markers.
 *    - wss://relay.deepmarks.org is always retained (deepmarks search
 *      index needs writes there to surface bookmarks).
 *  Single-flight write so a popup-open import can't race a settings UI
 *  toggle on the same array. */
export async function importNip65Relays(
  imported: Array<{ url: string; read: boolean; write: boolean }>,
): Promise<Settings> {
  const DEEPMARKS_RELAY = 'wss://relay.deepmarks.org';
  return mutateSettings((settings) => {
    const byUrl = new Map<string, RelayConfig>();
    for (const r of settings.relays) byUrl.set(r.url, r);
    for (const r of imported) {
      if (!byUrl.has(r.url)) byUrl.set(r.url, { url: r.url, read: r.read, write: r.write });
    }
    // Make sure the Deepmarks relay survives a sparse NIP-65 list.
    if (!byUrl.has(DEEPMARKS_RELAY)) {
      byUrl.set(DEEPMARKS_RELAY, { url: DEEPMARKS_RELAY, read: true, write: true });
    }
    return { ...settings, relays: [...byUrl.values()] };
  });
}

/** Convenience: just the read-enabled relay URLs. */
export async function getReadRelays(): Promise<string[]> {
  const { relays } = await getSettings();
  return relays.filter((r) => r.read).map((r) => r.url);
}

// ── Saved-logins helpers (NIP-07 "Forever" grants) ────────────────────

const SAVED_LOGIN_METHODS = new Set<SavedLoginMethod>([
  'getPublicKey',
  'getRelays',
  'signEvent',
  'nip04.encrypt',
  'nip04.decrypt',
  'nip44.encrypt',
  'nip44.decrypt',
  'webln.enable',
  'webln.getInfo',
]);

function normalizeSavedLogins(raw: unknown): SavedLogin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<SavedLogin> & { method?: unknown; kind?: unknown };
    if (typeof candidate.origin !== 'string') return [];
    if (typeof candidate.method !== 'string' || !SAVED_LOGIN_METHODS.has(candidate.method as SavedLoginMethod)) {
      // Legacy origin-wide grants were intentionally not migrated. They
      // are too broad for production signer behavior.
      return [];
    }
    if (candidate.method === 'signEvent') {
      if (typeof candidate.kind !== 'number' || !Number.isInteger(candidate.kind)) return [];
    }
    const grantedAt = typeof candidate.grantedAt === 'number' ? candidate.grantedAt : Math.floor(Date.now() / 1000);
    const lastUsedAt = typeof candidate.lastUsedAt === 'number' ? candidate.lastUsedAt : grantedAt;
    return [{
      origin: candidate.origin,
      method: candidate.method as SavedLoginMethod,
      ...(candidate.method === 'signEvent' ? { kind: candidate.kind as number } : {}),
      grantedAt,
      lastUsedAt,
    }];
  });
}

function toSyncedPayload(settings: Settings): Omit<SyncedSettings, 'schemaVersion' | 'updatedAt'> {
  return {
    relays: normalizeRelays(settings.relays),
    defaultTags: normalizeTags(settings.defaultTags),
    archiveAllByDefault: settings.archiveDefault,
    archiveDefaultManualOverride: settings.archiveDefaultManualOverride,
    defaultVisibility: settings.defaultVisibility,
    backupBlossomServers: normalizeBlossom(settings.backupBlossomServers),
  };
}

function mergeSyncedIntoLocal(current: Settings, remote: SyncedSettings): Settings {
  return {
    ...current,
    syncedAt: remote.updatedAt,
    relays: remote.relays,
    defaultTags: remote.defaultTags,
    archiveDefault: remote.archiveAllByDefault,
    archiveDefaultManualOverride: remote.archiveDefaultManualOverride,
    defaultVisibility: remote.defaultVisibility,
    backupBlossomServers: remote.backupBlossomServers,
  };
}

function normalizeSyncedSettings(raw: unknown): SyncedSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<SyncedSettings> : {};
  return {
    schemaVersion: 1,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    relays: normalizeRelays(value.relays),
    defaultTags: normalizeTags(value.defaultTags),
    archiveAllByDefault: !!value.archiveAllByDefault,
    archiveDefaultManualOverride: value.archiveDefaultManualOverride === true,
    defaultVisibility: value.defaultVisibility === 'public' ? 'public' : 'private',
    backupBlossomServers: normalizeBlossom(value.backupBlossomServers),
  };
}

function normalizeRelays(raw: unknown): RelayConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_RELAYS.map((r) => ({ ...r }));
  const out: RelayConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const relay = entry as Partial<RelayConfig>;
    if (typeof relay.url !== 'string') continue;
    const url = relay.url.trim().replace(/\/$/, '');
    if (!/^wss?:\/\/[^ ]+\.[^ ]+/.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, read: relay.read !== false, write: relay.write !== false });
  }
  return migrateLegacyDefaultRelays(out.length > 0 ? out : DEFAULT_RELAYS.map((r) => ({ ...r })));
}

function migrateLegacyDefaultRelays(relays: RelayConfig[]): RelayConfig[] {
  const urls = new Set(relays.map((relay) => relay.url));
  const isLegacyDefault =
    relays.length === LEGACY_DEFAULT_RELAY_URLS.length &&
    LEGACY_DEFAULT_RELAY_URLS.every((url) => urls.has(url));
  return isLegacyDefault
    ? relays.filter((relay) => relay.url !== DAMUS_RELAY)
    : relays;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_SETTINGS.defaultTags;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (!tag || tag.length > 48 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function normalizeBlossom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:') continue;
      if (seen.has(parsed.origin)) continue;
      seen.add(parsed.origin);
      out.push(parsed.origin);
    } catch {
      // skip malformed
    }
  }
  return out.slice(0, 8);
}

export function savedLoginMatches(login: SavedLogin, origin: string, scope: SavedLoginScope): boolean {
  return login.origin === origin &&
    login.method === scope.method &&
    (scope.method !== 'signEvent' || login.kind === scope.kind);
}

export function savedLoginLabel(login: SavedLoginScope): string {
  if (login.method === 'signEvent') return `sign kind:${login.kind ?? '?'}`;
  return login.method;
}

export async function rememberLoginForever(origin: string, scope: SavedLoginScope): Promise<void> {
  await mutateSettings((settings) => {
    if (settings.savedLogins.some((l) => savedLoginMatches(l, origin, scope))) return settings;
    const now = Math.floor(Date.now() / 1000);
    return {
      ...settings,
      savedLogins: [...settings.savedLogins, { origin, ...scope, grantedAt: now, lastUsedAt: now }],
    };
  });
}

export async function revokeLogin(origin: string, scope?: SavedLoginScope): Promise<void> {
  await mutateSettings((settings) => ({
    ...settings,
    savedLogins: settings.savedLogins.filter((l) =>
      scope ? !savedLoginMatches(l, origin, scope) : l.origin !== origin,
    ),
  }));
}

export async function touchSavedLogin(origin: string, scope: SavedLoginScope): Promise<void> {
  await mutateSettings((settings) => ({
    ...settings,
    savedLogins: settings.savedLogins.map((l) =>
      savedLoginMatches(l, origin, scope)
        ? { ...l, lastUsedAt: Math.floor(Date.now() / 1000) }
        : l,
    ),
  }));
}
