// Volatile popup drafts.
//
// Browser extension popups close whenever focus moves away from the
// popup. Chrome/Firefox do not expose a way to keep them open, so
// longer workflows need to survive a close/reopen cycle. Drafts live in
// chrome.storage.session only: cleared by browser restart and never
// written to disk-backed local storage.

import type { ActiveTabInfo } from '../../lib/active-tab.js';
import type { BookmarkVisibility } from '../../lib/settings-store.js';
import type { CacheMode } from '../../lib/nsec-store.js';

const LOGIN_DRAFT_KEY = 'deepmarks-popup-login-draft';
const ADD_DRAFT_KEY = 'deepmarks-popup-add-draft';
const DRAFT_TTL_MS = 30 * 60 * 1000;

interface StoredDraft<T> {
  updatedAt: number;
  value: T;
}

export type LoginDraftMode =
  | { kind: 'paste' }
  | { kind: 'generated'; nsec: string; backupConfirmed: boolean };

export interface LoginDraft {
  mode: LoginDraftMode;
  value: string;
  cacheMode: CacheMode;
}

export interface AddBookmarkDraft {
  tab: ActiveTabInfo;
  title: string;
  description: string;
  tags: string[];
  archive: boolean;
  crossPost: boolean;
  socialPost: string;
  showArchiveToggle: boolean;
  visibility: BookmarkVisibility;
  autofilled: boolean;
  editing: boolean;
  titleEdited: boolean;
  socialPostEdited: boolean;
  originalVisibility: BookmarkVisibility | null;
  originalEventId?: string;
}

export async function saveLoginDraft(draft: LoginDraft): Promise<void> {
  const hasMeaningfulPaste = draft.mode.kind === 'paste' && draft.value.trim().length > 0;
  const hasGeneratedKey = draft.mode.kind === 'generated' && /^nsec1/i.test(draft.mode.nsec);
  if (!hasMeaningfulPaste && !hasGeneratedKey) {
    await clearLoginDraft();
    return;
  }
  await setSessionDraft(LOGIN_DRAFT_KEY, {
    mode: sanitizeLoginMode(draft.mode),
    value: draft.mode.kind === 'paste' ? draft.value : '',
    cacheMode: draft.cacheMode,
  });
}

export async function loadLoginDraft(): Promise<LoginDraft | null> {
  const draft = await getSessionDraft<unknown>(LOGIN_DRAFT_KEY);
  return isLoginDraft(draft) ? draft : null;
}

export async function hasLoginDraft(): Promise<boolean> {
  return (await loadLoginDraft()) !== null;
}

export async function clearLoginDraft(): Promise<void> {
  await clearSessionDraft(LOGIN_DRAFT_KEY);
}

export async function saveAddBookmarkDraft(draft: AddBookmarkDraft): Promise<void> {
  await setSessionDraft(ADD_DRAFT_KEY, {
    ...draft,
    tags: draft.tags.filter((t) => typeof t === 'string').slice(0, 50),
    originalEventId: draft.originalEventId || undefined,
  });
}

export async function loadAddBookmarkDraft(): Promise<AddBookmarkDraft | null> {
  const draft = await getSessionDraft<unknown>(ADD_DRAFT_KEY);
  return isAddBookmarkDraft(draft) ? draft : null;
}

export async function hasAddBookmarkDraft(): Promise<boolean> {
  return (await loadAddBookmarkDraft()) !== null;
}

export async function clearAddBookmarkDraft(): Promise<void> {
  await clearSessionDraft(ADD_DRAFT_KEY);
}

function sanitizeLoginMode(mode: LoginDraftMode): LoginDraftMode {
  if (mode.kind === 'generated') {
    return {
      kind: 'generated',
      nsec: mode.nsec,
      backupConfirmed: mode.backupConfirmed,
    };
  }
  return { kind: 'paste' };
}

async function getSessionDraft<T>(key: string): Promise<T | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const raw = await area.get(key);
    const record = raw[key] as StoredDraft<T> | undefined;
    if (!record || typeof record !== 'object') return null;
    if (typeof record.updatedAt !== 'number' || Date.now() - record.updatedAt > DRAFT_TTL_MS) {
      await area.remove(key).catch(() => undefined);
      return null;
    }
    return record.value ?? null;
  } catch {
    return null;
  }
}

async function setSessionDraft<T>(key: string, value: T): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  await area.set({ [key]: { updatedAt: Date.now(), value } });
}

async function clearSessionDraft(key: string): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  await area.remove(key);
}

function sessionArea(): chrome.storage.StorageArea | null {
  const storage = chrome.storage as typeof chrome.storage & {
    session?: chrome.storage.StorageArea;
  };
  return storage.session ?? null;
}

function isLoginDraft(value: unknown): value is LoginDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LoginDraft>;
  if (v.cacheMode !== 'session' && v.cacheMode !== 'days30') return false;
  if (!v.mode || typeof v.mode !== 'object') return false;
  if (v.mode.kind === 'paste') return typeof v.value === 'string';
  if (v.mode.kind === 'generated') {
    return /^nsec1/i.test(v.mode.nsec) && typeof v.mode.backupConfirmed === 'boolean';
  }
  return false;
}

function isAddBookmarkDraft(value: unknown): value is AddBookmarkDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AddBookmarkDraft>;
  if (!v.tab || typeof v.tab !== 'object') return false;
  const tab = v.tab as Partial<ActiveTabInfo>;
  return (
    typeof tab.url === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.description === 'string' &&
    typeof tab.scraped === 'boolean' &&
    typeof v.title === 'string' &&
    typeof v.description === 'string' &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string') &&
    typeof v.archive === 'boolean' &&
    typeof v.crossPost === 'boolean' &&
    typeof v.socialPost === 'string' &&
    typeof v.showArchiveToggle === 'boolean' &&
    (v.visibility === 'private' || v.visibility === 'public') &&
    typeof v.autofilled === 'boolean' &&
    typeof v.editing === 'boolean' &&
    typeof v.titleEdited === 'boolean' &&
    typeof v.socialPostEdited === 'boolean' &&
    (v.originalVisibility === null || v.originalVisibility === 'private' || v.originalVisibility === 'public') &&
    (v.originalEventId === undefined || typeof v.originalEventId === 'string')
  );
}
