// Cached list of the signed-in user's contacts (people they follow on
// Nostr). Powers the @-mention autocomplete in SaveBox.
//
// Source is the server-side join: api/src/routes/contacts.ts
// reads `dm:follows:by-user:<pubkey>` (populated by the follows-ingester
// worker watching kind:3 contact lists) and joins it with the
// `dm:profile-name:*` + `dm:profile-event:*` caches the profile-resolver
// worker maintains. One HTTP round-trip per session — no per-keystroke
// relay traffic.
//
// We lazy-load on first invocation to keep app startup snappy; a manual
// refresh helper is exposed for the rare case where the user adds a
// follow in another client and wants to see it appear in autocomplete
// without re-signing in.

import { writable, get } from 'svelte/store';
import { session } from '$lib/stores/session';
import { config } from '$lib/config';
import { buildNip98AuthHeader, type AccountContact } from '$lib/api/client';
import { createCachedKv } from '$lib/util/cached-kv';
import { primeProfileCache, type Profile } from '$lib/nostr/profiles';

export type ContactEntry = AccountContact;

interface CacheState {
  contacts: ContactEntry[];
  loadedFor: string | null;
  loading: boolean;
  loadedAt: number;
}

const STALE_MS = 5 * 60_000; // refresh if older than 5 min on next request
const LOCAL_TTL_MS = 24 * 60 * 60_000;
const contactsStorage = createCachedKv<{ contacts: ContactEntry[]; hasContactList?: boolean }>({
  prefix: 'deepmarks-contacts-cache',
  version: 'v2',
  ttlMs: LOCAL_TTL_MS,
});

const state = writable<CacheState>({
  contacts: [],
  loadedFor: null,
  loading: false,
  loadedAt: 0,
});

export const contactsCache = { subscribe: state.subscribe };

let inFlight: Promise<ContactEntry[]> | null = null;

/**
 * Ensure the contacts list for the current signed-in user is loaded,
 * returning the resulting list. Multiple concurrent callers share the
 * single in-flight request.
 *
 * Returns an empty array on auth failure or network blip rather than
 * throwing — the autocomplete simply has nothing to suggest.
 */
export async function ensureContacts(force = false): Promise<ContactEntry[]> {
  const pubkey = get(session).pubkey;
  if (!pubkey) return [];
  primeContactsFromLocal(pubkey);
  const current = get(state);
  if (
    !force &&
    current.loadedFor === pubkey &&
    Date.now() - current.loadedAt < STALE_MS
  ) {
    return current.contacts;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    state.update((s) => ({ ...s, loading: true }));
    try {
      const url = `${config.apiBase}/account/contacts`;
      const auth = await buildNip98AuthHeader(url, 'GET');
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (!res.ok) {
        state.update((s) => ({ ...s, loading: false }));
        const fallback = get(state);
        return fallback.loadedFor === pubkey ? fallback.contacts : [];
      }
      const json = (await res.json()) as { contacts?: ContactEntry[] };
      const contacts = Array.isArray(json.contacts) ? json.contacts : [];
      contactsStorage.save(pubkey, { contacts });
      primeContactProfiles(contacts);
      state.set({
        contacts,
        loadedFor: pubkey,
        loading: false,
        loadedAt: Date.now(),
      });
      return contacts;
    } catch {
      state.update((s) => ({ ...s, loading: false }));
      const fallback = get(state);
      return fallback.loadedFor === pubkey ? fallback.contacts : [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Synchronously read the cached contacts without triggering a fetch.
 *  Returns [] when nothing's been loaded yet. */
export function peekContacts(): ContactEntry[] {
  const pubkey = get(session).pubkey;
  if (pubkey) primeContactsFromLocal(pubkey);
  const current = get(state);
  return current.loadedFor === pubkey ? current.contacts : [];
}

/** Local prefix filter used by the autocomplete dropdown. Matches the
 *  display name (case-insensitive contains) plus the nip05 handle as a
 *  fallback. Sorted by best match: exact name prefix first, then any
 *  substring, then nip05 hits. */
export function filterContacts(query: string, contacts: ContactEntry[], limit = 8): ContactEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return contacts.slice(0, limit);
  const exactPrefix: ContactEntry[] = [];
  const namePartial: ContactEntry[] = [];
  const nip05Hit: ContactEntry[] = [];
  for (const c of contacts) {
    const name = (c.name ?? '').toLowerCase();
    const nip05 = (c.nip05 ?? '').toLowerCase();
    if (name.startsWith(q)) exactPrefix.push(c);
    else if (name.includes(q)) namePartial.push(c);
    else if (nip05.includes(q)) nip05Hit.push(c);
    if (exactPrefix.length + namePartial.length + nip05Hit.length >= limit * 2) break;
  }
  return [...exactPrefix, ...namePartial, ...nip05Hit].slice(0, limit);
}

function primeContactsFromLocal(pubkey: string): void {
  const current = get(state);
  if (current.loadedFor === pubkey && current.contacts.length > 0) return;
  const cached = contactsStorage.loadWithMeta(pubkey);
  if (!cached) return;
  primeContactProfiles(cached.value.contacts);
  state.set({
    contacts: cached.value.contacts,
    loadedFor: pubkey,
    loading: false,
    loadedAt: cached.at,
  });
}

function primeContactProfiles(contacts: ContactEntry[]): void {
  primeProfileCache(contacts.map(profileFromContact));
}

function profileFromContact(contact: ContactEntry): Profile | null {
  const pubkey = contact.pubkey?.toLowerCase();
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
  return {
    pubkey,
    name: contact.name,
    displayName: contact.name,
    picture: contact.picture,
    nip05: contact.nip05,
  };
}
