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
import type { Deps } from '../route-deps.js';

const MAX_CONTACTS = 5_000;

interface ContactResponseEntry {
  pubkey: string;
  npub: string;
  name?: string;
  picture?: string;
  nip05?: string;
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
  const { app, redis, requireNip98, rateLimit, PUBLIC_BASE_URL } = deps;

  app.get('/account/contacts', async (request, reply) => {
    const auth = await requireNip98(
      request,
      reply,
      `${PUBLIC_BASE_URL}/account/contacts`,
      'GET',
    );
    if (!auth) return;

    const gate = await rateLimit('contacts-list', auth.pubkey, 30, 60);
    if (!gate.ok) {
      reply.header('Retry-After', String(gate.retryAfter));
      return reply.status(429).send({ error: 'rate limit', retryAfter: gate.retryAfter });
    }

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

    // One Redis MGET per cache. Both cacjes share TTL via the
    // profile-resolver worker, so a missing entry on one side is
    // typically also missing on the other. Empty/null entries just
    // fall through to the bare pubkey in the response.
    const nameKeys = capped.map((p) => `dm:profile-name:${p}`);
    const eventKeys = capped.map((p) => `dm:profile-event:${p}`);
    const [names, events] = await Promise.all([
      redis.mget(...nameKeys).catch(() => [] as Array<string | null>),
      redis.mget(...eventKeys).catch(() => [] as Array<string | null>),
    ]);

    const contacts: ContactResponseEntry[] = capped.map((pubkey, i) => {
      const entry: ContactResponseEntry = {
        pubkey,
        npub: safeNpub(pubkey),
      };
      const name = names[i];
      if (name) entry.name = name;
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
            // Prefer the cached profile-resolver display name (the
            // sanitized + length-capped version); fall back to the
            // raw display_name fields off the event for completeness.
            if (!entry.name) entry.name = meta.display_name ?? meta.displayName ?? meta.name;
            if (typeof meta.picture === 'string') entry.picture = meta.picture;
            if (typeof meta.nip05 === 'string') entry.nip05 = meta.nip05;
          }
        } catch { /* corrupt cache — fall through with whatever we have */ }
      }
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
}

function safeNpub(pubkey: string): string {
  try { return nip19.npubEncode(pubkey); }
  catch { return ''; }
}
