import { describe, expect, it, vi } from 'vitest';
import type { RemoteAccountSettings, UserSettings } from './user-settings';
import { mergeBookmarkTagsWithDefaults, pendingLocalSettingsShouldWin } from './user-settings';

vi.mock('$app/environment', () => ({ browser: false }));

const relays = [{ url: 'wss://relay.deepmarks.org', read: true, write: true }];

function local(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    relays,
    defaultTags: ['toread'],
    defaultVisibility: 'public',
    archiveAllByDefault: false,
    archiveDefaultManualOverride: false,
    backupBlossomServers: [],
    theme: 'auto',
    pendingSync: true,
    syncedAt: 100,
    ...overrides,
  };
}

function remote(updatedAt: number): RemoteAccountSettings {
  return {
    updatedAt,
    relays,
    defaultTags: ['toread'],
    defaultVisibility: 'private',
    archiveAllByDefault: false,
    archiveDefaultManualOverride: false,
    backupBlossomServers: [],
    theme: 'auto',
  };
}

describe('pendingLocalSettingsShouldWin', () => {
  it('keeps pending local settings when the remote timestamp is older', () => {
    expect(pendingLocalSettingsShouldWin(local(), remote(99))).toBe(true);
  });

  it('keeps pending local settings when timestamps are equal', () => {
    expect(pendingLocalSettingsShouldWin(local(), remote(100))).toBe(true);
  });

  it('accepts newer remote settings', () => {
    expect(pendingLocalSettingsShouldWin(local(), remote(101))).toBe(false);
  });

  it('accepts remote settings when there is no pending local change', () => {
    expect(pendingLocalSettingsShouldWin(local({ pendingSync: false }), remote(100))).toBe(false);
  });
});

describe('mergeBookmarkTagsWithDefaults', () => {
  it('adds default read-later tags without dropping existing tags', () => {
    expect(mergeBookmarkTagsWithDefaults(['bitcoin'], ['toread'])).toEqual(['bitcoin', 'toread']);
  });

  it('dedupes and normalizes tags while keeping user tag order first', () => {
    expect(mergeBookmarkTagsWithDefaults(['AI', '#nostr'], ['ai', 'toread'])).toEqual([
      'ai',
      'nostr',
      'toread',
    ]);
  });
});
