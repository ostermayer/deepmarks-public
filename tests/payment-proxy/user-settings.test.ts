import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsInputSchema,
  UserSettingsStore,
} from '@src/user-settings.js';

class FakeRedis {
  kv = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.kv.get(key) ?? null; }
  async set(key: string, value: string): Promise<'OK'> { this.kv.set(key, value); return 'OK'; }
  async del(key: string): Promise<number> { return this.kv.delete(key) ? 1 : 0; }
}

const PUBKEY = 'a'.repeat(64);

describe('UserSettingsStore', () => {
  it('returns defaults for a new pubkey', async () => {
    const store = new UserSettingsStore(new FakeRedis() as unknown as Redis);
    await expect(store.get(PUBKEY)).resolves.toMatchObject({
      defaultVisibility: 'public',
      archiveAllByDefault: false,
      archiveDefaultManualOverride: false,
      defaultTags: [],
      relays: DEFAULT_USER_SETTINGS.relays,
      theme: 'auto',
    });
  });

  it('persists normalized cross-client preferences', async () => {
    const store = new UserSettingsStore(new FakeRedis() as unknown as Redis);
    const input = UserSettingsInputSchema.parse({
      relays: [
        { url: 'wss://relay.example.com/', read: true, write: false },
        { url: 'wss://relay.example.com', read: false, write: true },
      ],
      defaultTags: ['AI', '#ai', 'nostr'],
      defaultVisibility: 'public',
      archiveAllByDefault: true,
      archiveDefaultManualOverride: true,
      backupBlossomServers: ['https://blossom.example.com/path'],
      theme: 'dark',
    });

    const saved = await store.put(PUBKEY, input);
    expect(saved.relays).toEqual([{ url: 'wss://relay.example.com', read: true, write: false }]);
    expect(saved.defaultTags).toEqual(['ai', 'nostr']);
    expect(saved.defaultVisibility).toBe('public');
    expect(saved.archiveAllByDefault).toBe(true);
    expect(saved.archiveDefaultManualOverride).toBe(true);
    expect(saved.backupBlossomServers).toEqual(['https://blossom.example.com']);
    expect(saved.theme).toBe('dark');
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('preserves existing fields when older clients omit newer settings', async () => {
    const store = new UserSettingsStore(new FakeRedis() as unknown as Redis);
    await store.put(PUBKEY, UserSettingsInputSchema.parse({ theme: 'dark', defaultVisibility: 'public' }));
    const saved = await store.put(PUBKEY, UserSettingsInputSchema.parse({ defaultTags: ['later'] }));
    expect(saved.theme).toBe('dark');
    expect(saved.defaultVisibility).toBe('public');
    expect(saved.defaultTags).toEqual(['later']);
  });

  it('deletes a settings document on account tombstone', async () => {
    const redis = new FakeRedis();
    const store = new UserSettingsStore(redis as unknown as Redis);
    await store.put(PUBKEY, UserSettingsInputSchema.parse({ defaultVisibility: 'public' }));
    await expect(store.delete(PUBKEY)).resolves.toBe(true);
    await expect(store.get(PUBKEY)).resolves.toMatchObject({ defaultVisibility: 'public' });
  });
});
