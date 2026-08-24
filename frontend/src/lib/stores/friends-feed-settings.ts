import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface FriendsFeedSettings {
  includeSocialPosts: boolean;
}

const STORAGE_KEY = 'deepmarks-friends-feed-settings:v1';

const DEFAULTS: FriendsFeedSettings = {
  includeSocialPosts: false,
};

function load(): FriendsFeedSettings {
  if (!browser) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<FriendsFeedSettings>;
    return {
      includeSocialPosts: parsed.includeSocialPosts === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings: FriendsFeedSettings): void {
  if (!browser) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing / quota: keep the in-memory preference.
  }
}

function createStore(): Writable<FriendsFeedSettings> {
  const inner = writable<FriendsFeedSettings>(load());
  inner.subscribe(save);
  return inner;
}

export const friendsFeedSettings = createStore();
