import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginDraft,
  loadAddBookmarkDraft,
  loadLoginDraft,
  saveAddBookmarkDraft,
  saveLoginDraft,
} from '@src/popup/screens/popup-drafts.js';

const session = new Map<string, unknown>();

function installChromeMock() {
  globalThis.chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: session.get(key) })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
          session.delete(key);
        }),
      },
    },
  } as unknown as typeof chrome;
}

describe('popup drafts', () => {
  beforeEach(() => {
    session.clear();
    installChromeMock();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
  });

  it('restores login drafts without storing passwords', async () => {
    await saveLoginDraft({
      mode: { kind: 'paste' },
      value: 'nsec1example',
      cacheMode: 'session',
    });

    await expect(loadLoginDraft()).resolves.toEqual({
      mode: { kind: 'paste' },
      value: 'nsec1example',
      cacheMode: 'session',
    });
  });

  it('clears empty login drafts', async () => {
    await saveLoginDraft({
      mode: { kind: 'paste' },
      value: '',
      cacheMode: 'session',
    });

    await expect(loadLoginDraft()).resolves.toBeNull();
  });

  it('expires stale drafts', async () => {
    await saveLoginDraft({
      mode: { kind: 'paste' },
      value: 'nsec1example',
      cacheMode: 'session',
    });
    vi.setSystemTime(new Date('2026-05-11T12:31:00Z'));

    await expect(loadLoginDraft()).resolves.toBeNull();
  });

  it('restores add-bookmark drafts', async () => {
    await saveAddBookmarkDraft({
      tab: { url: 'https://example.com', title: 'Example', description: 'Desc', scraped: true },
      title: 'Edited title',
      description: 'Edited desc',
      tags: ['nostr', 'read'],
      archive: true,
      crossPost: true,
      socialPost: 'sharing this',
      showArchiveToggle: true,
      visibility: 'public',
      autofilled: false,
      editing: false,
      titleEdited: true,
      socialPostEdited: true,
      originalVisibility: null,
    });

    await expect(loadAddBookmarkDraft()).resolves.toMatchObject({
      tab: { url: 'https://example.com' },
      title: 'Edited title',
      tags: ['nostr', 'read'],
      visibility: 'public',
    });
  });

  it('clears login drafts explicitly', async () => {
    await saveLoginDraft({
      mode: { kind: 'paste' },
      value: 'nsec1example',
      cacheMode: 'session',
    });
    await clearLoginDraft();

    await expect(loadLoginDraft()).resolves.toBeNull();
  });
});
