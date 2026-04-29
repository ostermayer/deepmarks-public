// Lightweight per-user UI preferences, persisted to localStorage.
//
// Keep this narrow — large blobs and anything cross-device belongs in
// Nostr kind:30078 (NIP-78 app-specific data). For "remember that I
// ticked the archive-by-default box" a one-byte flag in localStorage
// is exactly the right tool.

import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface UserSettings {
  /** If true, the "archive forever" checkbox is pre-ticked on every save
   *  dialog. Only meaningful for lifetime members (free) or users who
   *  want to buy one archive per save. */
  archiveAllByDefault: boolean;
}

const DEFAULTS: UserSettings = {
  archiveAllByDefault: false,
};

const STORAGE_KEY = 'deepmarks-user-settings:v1';

function load(): UserSettings {
  if (!browser) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
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
