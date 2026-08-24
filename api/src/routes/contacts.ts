// /account/contacts — returns the signed-in user's follow list
// (NIP-02 kind:3 captured by the follows-ingester worker) enriched
// with each contact's display name + picture from the profile cache.
//
// Used by the frontend's @-mention autocomplete: while typing a
// social post the client GETs this once per session, then filters
// the list locally by prefix as the user types. Keeping the join
// server-side means the mobile app only does a single round-trip
// to one relay (relay.deepmarks.org) and one HTTP request — no
// per-keystroke relay traffic, no NIP-65 outbox routing on the
// client.

import { nip19 } from 'nostr-tools';
import { enqueueOnboardingScan } from '../registry.js';
import { REGISTERED_PUBKEYS_SET } from '../registry.js';
import type { Deps } from '../route-deps.js';

const MAX_CONTACTS = 5_000;
const MAX_PEOPLE_RESULTS = 40;
const MAX_ACCOUNT_SCAN = 20_000;
const CONTACTS_WATCHED_SET = 'dm:contacts:watched';
const CONTACTS_LAST_INGEST_PREFIX = 'dm:contacts:last-ingest:v2:';
const MAX_PROFILE_WARM_REQUESTS = 500;

interface ContactResponseEntry {
  pubkey: string;
  npub: string;
  name?: string;
  picture?: string;
  nip05?: string;
  deepmarksUsername?: string;
  registered?: boolean;
}

interface ContactsResponse {
  count: number;
  contacts: ContactResponseEntry[];
  /** Indicates whether the server has any cached follow data for this
   *  user yet. False means the follows-ingester hasn't seen a kind:3
   *  from them; the frontend can use this to nudge the user to
   *  publish their contact list. */
  hasContactList: boolean;
}

export function register(deps: Deps): void {
  const { app, redis, requireNip98, gateRateLimit, PUBLIC_BASE_URL } = deps;

  app.get('/account/contacts', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/contacts`,
      'GET',
    );
    if (!auth) return;

    if (!(await gateRateLimit(reply, 'contacts-list', auth.pubkey, 30, 60))) return reply;

    const followsKey = `dm:follows:by-user:${auth.pubkey}`;
    const pubkeys = await redis.smembers(followsKey).catch(() => [] as string[]);
    const hasContactList = pubkeys.length > 0;
    if (!hasContactList) {
      // No follows cached yet — either the user just signed up or their
      // kind:3 lives on a third-party relay we haven't ingested from
      // yet. Kick off a one-shot onboarding scan so the next call to
      // this endpoint has data to return. The scan dedups via its own
      // marker so this is idempotent across rapid retries.
      void enqueueOnboardingScan(redis, auth.pubkey).catch(() => undefined);
    }

    // Add the public-facing @deepmarks brand account as a built-in
    // suggestion so users can tag us even before they follow. Skip
    // when they're tagging themselves or already follow us.
    const brandPubkey = (process.env.DEEPMARKS_PUBLIC_BRAND_PUBKEY ?? '').toLowerCase();
    const augmented = new Set(pubkeys);
    if (brandPubkey && brandPubkey !== auth.pubkey) augmented.add(brandPubkey);
    const capped = [...augmented].slice(0, MAX_CONTACTS);

    // One Redis MGET per cache. Both caches share TTL via the
    // profile-resolver worker, so a missing entry on one side is
    // typically also missing on the other. Empty/null entries just
    // fall through to the bare pubkey in the response.
    const nameKeys = capped.map((p) => `dm:profile-name:${p}`);
    const eventKeys = capped.map((p) => `dm:profile-event:${p}`);
    const [names, events] = await Promise.all([
      redis.mget(...nameKeys).catch(() => [] as Array<string | null>),
      redis.mget(...eventKeys).catch(() => [] as Array<string | null>),
    ]);

    // If the contacts list exists but some people still lack profile
    // metadata, nudge the follows-ingester to refresh them. This keeps
    // the next open of the friends picker from falling back to npubs.
    const missingProfiles = capped
      .filter((pubkey, i) => (!names[i] || !events[i]) && /^[0-9a-f]{64}$/.test(pubkey))
      .slice(0, MAX_PROFILE_WARM_REQUESTS);
    if (missingProfiles.length > 0) {
      const warm = redis.pipeline();
      warm.sadd(CONTACTS_WATCHED_SET, ...missingProfiles);
      for (const pubkey of missingProfiles) {
        warm.del(CONTACTS_LAST_INGEST_PREFIX + pubkey);
      }
      void warm.exec().catch(() => undefined);
    }

    const contacts: ContactResponseEntry[] = capped.map((pubkey, i) => {
      const entry: ContactResponseEntry = {
        pubkey,
        npub: safeNpub(pubkey),
      };
      let profileName = names[i] ?? undefined;
      const eventRaw = events[i];
      if (eventRaw) {
        try {
          const parsed = JSON.parse(eventRaw) as { content?: string };
          if (parsed.content) {
            const meta = JSON.parse(parsed.content) as {
              picture?: string;
              display_name?: string;
              displayName?: string;
              name?: string;
              nip05?: string;
            };
            profileName = preferredProfileName(meta) ?? profileName;
            if (typeof meta.picture === 'string') entry.picture = meta.picture;
            if (typeof meta.nip05 === 'string') entry.nip05 = meta.nip05;
          }
        } catch { /* corrupt cache — fall through with whatever we have */ }
      }
      if (profileName) entry.name = profileName;
      return entry;
    });

    // Sort: contacts with a resolved name first (more useful in the
    // autocomplete dropdown), then alphabetically by name, then by
    // the raw hex for stable ordering on contacts we don't know yet.
    contacts.sort((a, b) => {
      if (!!a.name !== !!b.name) return a.name ? -1 : 1;
      if (a.name && b.name) return a.name.localeCompare(b.name);
      return a.pubkey.localeCompare(b.pubkey);
    });

    reply.header('cache-control', 'private, max-age=60');
    const body: ContactsResponse = {
      count: contacts.length,
      contacts,
      hasContactList,
    };
    return body;
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/account/people-search', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}${request.url}`,
      'GET',
    );
    if (!auth) return;

    if (!(await gateRateLimit(reply, 'people-search', auth.pubkey, 60, 60))) return reply;

    const query = (request.query.q ?? '').trim();
    const limit = Math.min(
      Math.max(Number.parseInt(request.query.limit ?? String(MAX_PEOPLE_RESULTS), 10) || MAX_PEOPLE_RESULTS, 1),
      MAX_PEOPLE_RESULTS,
    );
    const exactPubkey = pubkeyFromQuery(query);
    const needle = normalizePeopleQuery(query);
    if (!exactPubkey && needle.length < 2) {
      return { query, count: 0, people: [] };
    }

    const usernameByPubkey = await redis.hgetall('dm:username:bypubkey').catch(() => ({} as Record<string, string>));
    const candidates = exactPubkey
      ? await exactRegisteredCandidate(redis, exactPubkey)
      : await scanRegisteredPubkeys(redis);

    const people: ContactResponseEntry[] = [];
    for (const batch of chunks(candidates, 200)) {
      const profileKeys = batch.map((pubkey) => `dm:profile-event:${pubkey}`);
      const fallbackNameKeys = batch.map((pubkey) => `dm:profile-name:${pubkey}`);
      const [profileRaws, fallbackNames] = await Promise.all([
        redis.mget(...profileKeys).catch(() => [] as Array<string | null>),
        redis.mget(...fallbackNameKeys).catch(() => [] as Array<string | null>),
      ]);
      for (let i = 0; i < batch.length; i++) {
        const pubkey = batch[i]!;
        if (pubkey === auth.pubkey) continue;
        const profile = profileFromCache(profileRaws[i], fallbackNames[i]);
        const deepmarksUsername = usernameByPubkey[pubkey];
        if (!exactPubkey && !personMatches(needle, pubkey, profile, deepmarksUsername)) continue;
        people.push({
          pubkey,
          npub: safeNpub(pubkey),
          registered: true,
          ...(profile.name ? { name: profile.name } : {}),
          ...(profile.picture ? { picture: profile.picture } : {}),
          ...(profile.nip05 ? { nip05: profile.nip05 } : {}),
          ...(deepmarksUsername ? { deepmarksUsername } : {}),
        });
      }
      if (people.length >= limit * 2) break;
    }

    people.sort((a, b) => scorePerson(needle, b) - scorePerson(needle, a) || personLabel(a).localeCompare(personLabel(b)));
    const out = dedupePeople(people).slice(0, limit);
    reply.header('cache-control', 'private, max-age=30');
    return { query, count: out.length, people: out };
  });
}

function safeNpub(pubkey: string): string {
  try { return nip19.npubEncode(pubkey); }
  catch { return ''; }
}

function preferredProfileName(meta: {
  name?: string;
  display_name?: string;
  displayName?: string;
}): string | undefined {
  for (const candidate of [meta.name, meta.display_name, meta.displayName]) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.trim();
    if (cleaned && cleaned.length <= 64) return cleaned;
  }
  return undefined;
}

function normalizePeopleQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '');
}

function pubkeyFromQuery(raw: string): string | null {
  const q = raw.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(q)) return q;
  if (!q.startsWith('npub1')) return null;
  try {
    const decoded = nip19.decode(q);
    return decoded.type === 'npub' && typeof decoded.data === 'string'
      ? decoded.data.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// Candidates come from the LIVE registry set (dm:registered:pubkeys).
// The old source was the email-account store's dm:pk:* namespace — which
// never had a writer, so people-search always returned empty (2026-08-23
// cleanup review). With ~200k registered pubkeys, the no-exact-match path
// samples the first MAX_ACCOUNT_SCAN members, as the original design did.
async function exactRegisteredCandidate(redis: Deps['redis'], pubkey: string): Promise<string[]> {
  const member = await redis.sismember(REGISTERED_PUBKEYS_SET, pubkey).catch(() => 0);
  return member ? [pubkey] : [];
}

async function scanRegisteredPubkeys(redis: Deps['redis']): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, members] = await redis.sscan(REGISTERED_PUBKEYS_SET, cursor, 'COUNT', 500);
    cursor = next;
    for (const raw of members) {
      const pubkey = raw.toLowerCase();
      if (/^[0-9a-f]{64}$/.test(pubkey)) out.push(pubkey);
      if (out.length >= MAX_ACCOUNT_SCAN) return out;
    }
  } while (cursor !== '0');
  return out;
}

function profileFromCache(raw: string | null | undefined, fallbackName: string | null | undefined): {
  name?: string;
  picture?: string;
  nip05?: string;
} {
  const out: { name?: string; picture?: string; nip05?: string } = {};
  if (raw) {
    try {
      const event = JSON.parse(raw) as { content?: string };
      if (event.content) {
        const meta = JSON.parse(event.content) as {
          name?: string;
          display_name?: string;
          displayName?: string;
          picture?: string;
          nip05?: string;
        };
        const name = preferredProfileName(meta);
        if (name) out.name = name;
        if (typeof meta.picture === 'string' && meta.picture.trim()) out.picture = meta.picture.trim();
        if (typeof meta.nip05 === 'string' && meta.nip05.trim()) out.nip05 = meta.nip05.trim();
      }
    } catch { /* corrupt profile cache — use fallback name below */ }
  }
  if (!out.name && fallbackName) out.name = fallbackName;
  return out;
}

function personMatches(
  needle: string,
  pubkey: string,
  profile: { name?: string; nip05?: string },
  deepmarksUsername?: string,
): boolean {
  return [
    profile.name,
    profile.nip05,
    deepmarksUsername,
    pubkey,
    safeNpub(pubkey),
  ].some((value) => value?.toLowerCase().includes(needle));
}

function scorePerson(needle: string, person: ContactResponseEntry): number {
  const fields = [person.name, person.nip05, person.deepmarksUsername].filter((v): v is string => !!v);
  if (fields.some((v) => v.toLowerCase() === needle)) return 100;
  if (fields.some((v) => v.toLowerCase().startsWith(needle))) return 50;
  if (fields.some((v) => v.toLowerCase().includes(needle))) return 10;
  return 0;
}

function personLabel(person: ContactResponseEntry): string {
  return person.name ?? person.nip05 ?? person.deepmarksUsername ?? person.pubkey;
}

function dedupePeople(people: ContactResponseEntry[]): ContactResponseEntry[] {
  const seen = new Set<string>();
  const out: ContactResponseEntry[] = [];
  for (const person of people) {
    if (seen.has(person.pubkey)) continue;
    seen.add(person.pubkey);
    out.push(person);
  }
  return out;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
