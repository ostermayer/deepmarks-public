// User-tunable settings — all browser.storage.local-backed. The popup
// reads these to render Settings; the background uses them when
// publishing (relays, default tags) and when handling NIP-07 sign
// requests (savedLogins).
//
// Defaults match the deepmarks.org web app's defaults so cross-device
// behavior is consistent.

const KEY = 'deepmarks-settings';

export interface RelayConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface SavedLogin {
  /** Origin like `https://stacker.news` */
  origin: string;
  /** Unix seconds — when the user granted "Forever". */
  grantedAt: number;
  /** Last time we used the grant — UI shows "last used Nd ago". */
  lastUsedAt: number;
}

export type BookmarkVisibility = 'private' | 'public';

export interface Settings {
  schemaVersion: number;
  relays: RelayConfig[];
  defaultTags: string[];
  archiveDefault: boolean;
  archiveOnlyPaywalled: boolean;
  /** Initial visibility for new bookmarks. The Add screen pre-selects
   *  this; user can flip per-bookmark. Default: private (matches the
   *  "your data, your call" framing — most people don't want every
   *  saved page to be a public broadcast). */
  defaultVisibility: BookmarkVisibility;
  savedLogins: SavedLogin[];
}

const CURRENT_SCHEMA_VERSION = 1;

// Default relays match frontend/src/lib/config.ts. Keeping them in
// sync means a user signed in on the web + the extension publishes to
// the same set on both surfaces.
export const DEFAULT_RELAYS: RelayConfig[] = [
  { url: 'wss://relay.deepmarks.org', read: true,  write: true  },
  { url: 'wss://relay.damus.io',      read: true,  write: true  },
  { url: 'wss://nos.lol',             read: true,  write: true  },
  { url: 'wss://relay.primal.net',    read: true,  write: true  },
];

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  relays: DEFAULT_RELAYS,
  defaultTags: ['toread'],
  archiveDefault: false,
  archiveOnlyPaywalled: false,
  defaultVisibility: 'private',
  savedLogins: [],
};

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  const value = raw[KEY] as Partial<Settings> | undefined;
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  // Merge with defaults so newly-added fields pick up sensible values
  // for users who installed before that field existed.
  return { ...DEFAULT_SETTINGS, ...value, schemaVersion: CURRENT_SCHEMA_VERSION };
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

async function mutateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  return withWriteLock(async () => {
    const current = await getSettings();
    const next = fn(current);
    await setSettings(next);
    return next;
  });
}

/** Convenience: just the write-enabled relay URLs. */
export async function getWriteRelays(): Promise<string[]> {
  const { relays } = await getSettings();
  return relays.filter((r) => r.write).map((r) => r.url);
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

export async function rememberLoginForever(origin: string): Promise<void> {
  await mutateSettings((settings) => {
    if (settings.savedLogins.some((l) => l.origin === origin)) return settings;
    const now = Math.floor(Date.now() / 1000);
    return {
      ...settings,
      savedLogins: [...settings.savedLogins, { origin, grantedAt: now, lastUsedAt: now }],
    };
  });
}

export async function revokeLogin(origin: string): Promise<void> {
  await mutateSettings((settings) => ({
    ...settings,
    savedLogins: settings.savedLogins.filter((l) => l.origin !== origin),
  }));
}

export async function touchSavedLogin(origin: string): Promise<void> {
  await mutateSettings((settings) => ({
    ...settings,
    savedLogins: settings.savedLogins.map((l) =>
      l.origin === origin ? { ...l, lastUsedAt: Math.floor(Date.now() / 1000) } : l,
    ),
  }));
}
