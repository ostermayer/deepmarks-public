// Persisted theme store — light | dark | auto (follow system).
// app.html applies the saved value before first paint to avoid FOUC; this
// store keeps the runtime in sync after that.

import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'light' | 'dark' | 'auto';
const STORAGE_KEY = 'deepmarks-theme';

function readInitial(): Theme {
  if (!browser) return 'auto';
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}

function apply(theme: Theme) {
  if (!browser) return;
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(STORAGE_KEY);
  } else {
    root.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }
}

function createThemeStore() {
  const { subscribe, set } = writable<Theme>(readInitial());
  return {
    subscribe,
    set(theme: Theme) {
      apply(theme);
      set(theme);
    },
    toggle() {
      // Cycle light → dark → auto → light (matches what users expect from a
      // single toggle while still exposing the "follow system" option).
      const current = readInitial();
      const next: Theme =
        current === 'light' ? 'dark' : current === 'dark' ? 'auto' : 'light';
      apply(next);
      set(next);
    }
  };
}

export const theme = createThemeStore();
