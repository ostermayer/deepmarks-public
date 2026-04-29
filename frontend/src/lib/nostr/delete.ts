// NIP-09 deletion requests.
//
// Used by the "delete account" flow to broadcast a kind:5 event referencing
// every piece of user content we can find. The user's own signer signs it,
// then we publish to the full relay set so the request fans out. Relays
// are not required to honor kind:5 — copies on well-behaved nodes vanish,
// others keep the events. The settings UI makes this caveat clear.

import { NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';

/** Kinds we attempt to delete on account tombstone. kind:0 is included so
 *  a fresh claimant of the same nsec starts with a blank profile. */
const KINDS_TO_DELETE: number[] = [
  KIND.profile,
  KIND.relayList,
  KIND.blossomServers,
  KIND.privateBookmarkSet,
  KIND.webBookmark,
];

export interface DeleteAccountEventsResult {
  foundEvents: number;
  deletionEventId: string | null;
  relays: string[];
  reason: string | null;
}

/**
 * Fetch every event the user has published in the kinds we care about,
 * build one kind:5 event that references all of them, sign + publish.
 *
 * Returns the published event id (or null if there was nothing to delete)
 * and the list of relays that accepted the delete request.
 */
export async function publishAccountDeletion(pubkey: string): Promise<DeleteAccountEventsResult> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer — sign in first');

  const filter: NDKFilter = { authors: [pubkey], kinds: KINDS_TO_DELETE, limit: 500 };
  const events = await ndk.fetchEvents(filter);
  const arr = Array.from(events);

  if (arr.length === 0) {
    return { foundEvents: 0, deletionEventId: null, relays: [], reason: 'no events to delete' };
  }

  // NIP-09: use `e` tags for the event IDs, and for replaceable /
  // addressable events also emit an `a` tag so late-arriving copies on
  // new relays can be matched by the (kind, pubkey, d) coordinate.
  const tags: string[][] = [];
  const kindsSeen = new Set<number>();
  for (const ev of arr) {
    kindsSeen.add(ev.kind ?? 0);
    tags.push(['e', ev.id]);
    const d = ev.tags.find((t) => t[0] === 'd')?.[1];
    const isReplaceable = ev.kind !== undefined && (
      ev.kind === 0 ||
      ev.kind === 3 ||
      (ev.kind >= 10000 && ev.kind < 20000) ||
      (ev.kind >= 30000 && ev.kind < 40000)
    );
    if (isReplaceable) {
      const coord = d
        ? `${ev.kind}:${pubkey}:${d}`
        : `${ev.kind}:${pubkey}:`;
      tags.push(['a', coord]);
    }
  }
  for (const k of kindsSeen) tags.push(['k', String(k)]);

  const deletion = new NDKEvent(ndk, {
    kind: KIND.deletion,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: 'account deleted by user',
  });

  const accepted = await deletion.publish();
  return {
    foundEvents: arr.length,
    deletionEventId: deletion.id,
    relays: Array.from(accepted).map((r) => r.url),
    reason: 'account deleted by user',
  };
}

export interface DeleteBookmarkResult {
  deletionEventId: string;
  relays: string[];
}

/**
 * Delete a single kind:39701 bookmark by its event id. For replaceable
 * events like kind:39701 we emit both an `e` tag (covering the specific
 * signed event that exists today) and an `a` tag with the parameterized
 * address (<kind>:<pubkey>:<d-tag>) so late-arriving replicas are also
 * scoped out. Signer required.
 */
export async function publishBookmarkDeletion(params: {
  pubkey: string;
  eventId: string;
  url: string;
  reason?: string;
}): Promise<DeleteBookmarkResult> {
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('no signer — sign in first');
  const { pubkey, eventId, url, reason } = params;
  const tags: string[][] = [
    ['e', eventId],
    ['a', `${KIND.webBookmark}:${pubkey}:${url}`],
    ['k', String(KIND.webBookmark)],
  ];
  const deletion = new NDKEvent(ndk, {
    kind: KIND.deletion,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: reason ?? '',
  });
  const accepted = await deletion.publish();
  return {
    deletionEventId: deletion.id,
    relays: Array.from(accepted).map((r) => r.url),
  };
}
