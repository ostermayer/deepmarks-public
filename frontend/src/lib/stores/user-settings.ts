// Lightweight per-user UI preferences, persisted to localStorage.
//
// Keep this narrow. The server is the cross-device source of truth for
// non-secret preferences; localStorage is the fast local cache used on
// first paint and when the network/signer is temporarily unavailable.

import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export type BookmarkVisibility = 'private' | 'public';
export type ThemePreference = 'light' | 'dark' | 'auto';

export interface UserSettings {
  relays: RelayConfig[];
  defaultTags: string[];
  defaultVisibility: BookmarkVisibility;
  /** If true, the "archive forever" checkbox is pre-ticked on every save
   *  dialog. Only meaningful for lifetime members. */
  archiveAllByDefault: boolean;
  /** True once the user has explicitly chosen an archive default. Lifetime
   *  members start with archiving on until they opt out. */
  archiveDefaultManualOverride: boolean;
  /** User-owned Blossom servers to mirror archives to in addition to
   *  Deepmarks' operator defaults. Stored as normalized https origins. */
  backupBlossomServers: string[];
  /** Non-secret UI preference synced across Deepmarks app surfaces. */
  theme: ThemePreference;
  /** Local-only marker used when a change was saved locally but the
   *  server write has not completed yet. */
  pendingSync: boolean;
  syncedAt: number;
}

export const DEFAULT_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.deepmarks.org', read: true, write: true },
  { url: 'wss://nos.lol', read: true, write: true },
  { url: 'wss://relay.primal.net', read: true, write: true },
];

const DAMUS_RELAY = 'wss://relay.damus.io';
const LEGACY_DEFAULT_RELAY_URLS = [
  'wss://relay.deepmarks.org',
  DAMUS_RELAY,
  'wss://nos.lol',
  'wss://relay.primal.net',
];

const DEFAULTS: UserSettings = {
  relays: DEFAULT_RELAYS,
  defaultTags: [],
  defaultVisibility: 'public',
  archiveAllByDefault: false,
  archiveDefaultManualOverride: false,
  backupBlossomServers: [],
  theme: 'auto',
  pendingSync: false,
  syncedAt: 0,
};

const STORAGE_KEY = 'deepmarks-user-settings:v1';

function load(): UserSettings {
  if (!browser) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, theme: readLocalThemePreference() };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return {
      ...DEFAULTS,
      ...parsed,
      relays: normalizeRelays(parsed.relays),
      defaultTags: normalizeTags(parsed.defaultTags),
      defaultVisibility: parsed.defaultVisibility === 'private' ? 'private' : 'public',
      archiveAllByDefault: parsed.archiveAllByDefault === true,
      archiveDefaultManualOverride: parsed.archiveDefaultManualOverride === true,
      backupBlossomServers: Array.isArray(parsed.backupBlossomServers)
        ? parsed.backupBlossomServers.filter((v): v is string => typeof v === 'string')
        : DEFAULTS.backupBlossomServers,
      theme: normalizeTheme(parsed.theme ?? readLocalThemePreference()),
      pendingSync: parsed.pendingSync === true,
      syncedAt: typeof parsed.syncedAt === 'number' ? parsed.syncedAt : 0,
    };
  } catch {
    return { ...DEFAULTS, theme: readLocalThemePreference() };
  }
}

function save(settings: UserSettings): void {
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota / private browsing — tolerable.
  }
}

function createStore(): Writable<UserSettings> & { reset: () => void } {
  const inner = writable<UserSettings>(load());
  inner.subscribe((v) => save(v));
  return {
    ...inner,
    reset() { inner.set({ ...DEFAULTS }); },
  };
}

export const userSettings = createStore();

export function toSyncedAccountSettings(settings: UserSettings) {
  return {
    relays: settings.relays,
    defaultTags: settings.defaultTags,
    defaultVisibility: settings.defaultVisibility,
    archiveAllByDefault: settings.archiveAllByDefault,
    archiveDefaultManualOverride: settings.archiveDefaultManualOverride,
    backupBlossomServers: settings.backupBlossomServers,
    theme: settings.theme,
  };
}

export interface RemoteAccountSettings {
  updatedAt: number;
  relays: RelayConfig[];
  defaultTags: string[];
  defaultVisibility: BookmarkVisibility;
  archiveAllByDefault: boolean;
  archiveDefaultManualOverride: boolean;
  backupBlossomServers: string[];
  theme: ThemePreference;
}

export function mergeSyncedAccountSettings(
  current: UserSettings,
  remote: RemoteAccountSettings,
): UserSettings {
  return {
    ...current,
    ...remote,
    pendingSync: false,
    syncedAt: remote.updatedAt,
  };
}

export function pendingLocalSettingsShouldWin(
  current: UserSettings,
  remote: RemoteAccountSettings,
): boolean {
  // Local pending writes use Date.now() too. If timestamps tie, keep the
  // unsynced local edit and push it, because the server has not accepted
  // that local change yet.
  return current.pendingSync && remote.updatedAt <= current.syncedAt;
}

export function mergeBookmarkTagsWithDefaults(tags: string[], defaultTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...tags, ...defaultTags]) {
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (!tag || seen.has(tag) || tag.length > 48) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

export function normalizeRelays(raw: unknown): RelayConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_RELAYS.map((r) => ({ ...r }));
  const out: RelayConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const relay = entry as Partial<RelayConfig>;
    if (typeof relay.url !== 'string') continue;
    const url = relay.url.trim().replace(/\/$/, '');
    if (!/^wss?:\/\/[^ ]+\.[^ ]+/.test(url)) continue;
    if (seen.has(url)) continue;
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

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULTS.defaultTags;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = value.trim().replace(/^#/, '').toLowerCase();
    if (!tag || seen.has(tag) || tag.length > 48) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function normalizeTheme(raw: unknown): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : DEFAULTS.theme;
}

function readLocalThemePreference(): ThemePreference {
  if (!browser) return DEFAULTS.theme;
  return normalizeTheme(localStorage.getItem('deepmarks-theme'));
}
