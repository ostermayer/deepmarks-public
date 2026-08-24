import { readable, writable, get, type Readable } from 'svelte/store';
import type { NDKEvent, NDKFilter, NDKKind, NDKSubscription } from '@nostr-dev-kit/ndk';
import {
  buildPublicCollectionEvent,
  collectionFromPrivatePayload,
  collectionSlugFromInput,
  collectionTitleFromSlug,
  emptyCollection,
  isDeepmarksCollectionDTag,
  isPrivateCollectionDTag,
  isValidPrivateCollectionPayload,
  mergeCollectionLists,
  parsePublicCollectionEvent,
  privateCollectionDTag,
  privateCollectionPayload,
  upsertCollectionMember,
  type BookmarkCollection,
  type CollectionMember,
  type CollectionVisibility,
} from '$lib/bookmark-collections.js';
import type { ParsedBookmark, SignedEventLike, UnsignedEventTemplate } from './bookmarks.js';
import { ndkEventAsSigned } from './bookmarks.js';
import { canonicalRelaySet } from './canonical-relay-set.js';
import { getNdk } from './ndk.js';
import { KIND } from './kinds.js';
import { publishEventQueued, type PublishResult } from './publish.js';
import { SIGNER_OP_TIMEOUT_MS, withTimeout } from '$lib/util/promise-timeout.js';

const internal = writable<BookmarkCollection[]>([]);

export const ownCollections: Readable<BookmarkCollection[]> = {
  subscribe: internal.subscribe,
};

export interface CollectionWriteOptions {
  visibility?: CollectionVisibility;
  title?: string;
  description?: string;
}

export interface CollectionWriteResult {
  slug: string;
  collection: BookmarkCollection;
  publish: Promise<PublishResult>;
}

export interface PublicCollectionsFeedOptions {
  authors?: string[];
  limit?: number;
}

export async function refreshOwnCollections(ownerPubkey: string): Promise<void> {
  const owner = ownerPubkey.toLowerCase();
  try {
    const events = await fetchDeepmarksCollectionEvents(owner);
    const parsed: BookmarkCollection[] = [];
    for (const event of latestEventsByDTag(events)) {
      const publicCollection = parsePublicCollectionEvent(event);
      if (publicCollection) {
        parsed.push(publicCollection);
        continue;
      }
      const privateCollection = await decryptPrivateCollection(event, owner);
      if (privateCollection) parsed.push(privateCollection);
    }
    internal.set(mergeCollectionLists(parsed));
  } catch {
    internal.set([]);
  }
}

export function rememberOwnCollection(collection: BookmarkCollection): void {
  internal.update((current) => mergeCollectionLists(current, [collection]));
}

export function createPublicCollectionsFeed(
  opts: PublicCollectionsFeedOptions = {},
): Readable<BookmarkCollection[]> {
  return readable<BookmarkCollection[]>([], (set) => {
    const ndk = getNdk();
    const byDTag = new Map<string, BookmarkCollection>();
    const filter: NDKFilter = {
      kinds: [KIND.privateBookmarkSet as unknown as NDKKind],
      limit: opts.limit ?? 200,
    };
    if (opts.authors?.length) filter.authors = opts.authors.map((author) => author.toLowerCase());

    let active = true;
    function absorb(event: SignedEventLike): void {
      if (!active) return;
      const collection = parsePublicCollectionEvent(event);
      if (!collection) return;
      const key = `${collection.ownerPubkey}:${collection.dTag}`;
      const existing = byDTag.get(key);
      if (
        existing &&
        (existing.eventCreatedAt ?? 0) > (collection.eventCreatedAt ?? 0)
      ) {
        return;
      }
      byDTag.set(key, collection);
      set(mergeCollectionLists([...byDTag.values()]));
    }

    let sub: NDKSubscription | null = null;
    try {
      sub = ndk.subscribe(filter, { closeOnEose: false });
      sub.on('event', (event: NDKEvent) => absorb(ndkEventAsSigned(event)));
    } catch {
      set([]);
    }

    return () => {
      active = false;
      sub?.stop();
    };
  });
}

export async function addBookmarkToCollection(
  bookmark: ParsedBookmark,
  target: string | BookmarkCollection,
  ownerPubkey: string,
  options: CollectionWriteOptions = {},
): Promise<CollectionWriteResult> {
  const owner = ownerPubkey.toLowerCase();
  if (bookmark.curator.toLowerCase() !== owner) {
    throw new Error('you can only add your own bookmarks to collections');
  }
  return addUrlToCollection(bookmarkToMember(bookmark), target, owner, options);
}

export async function createCollection(
  input: string,
  ownerPubkey: string,
  options: CollectionWriteOptions = {},
): Promise<CollectionWriteResult> {
  const owner = ownerPubkey.toLowerCase();
  const slug = collectionSlugFromInput(input);
  if (!slug) throw new Error('enter a collection name');
  if (findCollection(slug)) throw new Error('collection already exists');

  const visibility = options.visibility ?? 'public';
  const title = options.title?.trim() ||
    (input.trim() && collectionSlugFromInput(input) !== input.trim()
      ? input.trim()
      : collectionTitleFromSlug(slug));
  const base = emptyCollection(title || slug, owner, visibility);
  const collection = visibility === 'private'
    ? { ...base, dTag: await privateCollectionDTag(slug) }
    : base;

  rememberOwnCollection(collection);
  const template = await buildCollectionEvent(collection, owner);
  const publish = publishEventQueued(template, owner, { failureSubject: 'collection' })
    .then((result) => {
      rememberOwnCollection({
        ...collection,
        eventId: result.eventId || collection.eventId,
        eventCreatedAt: template.created_at,
      });
      return result;
    })
    .catch((error) => {
      void refreshOwnCollections(owner);
      throw error;
    });

  return { slug, collection, publish };
}

export async function addUrlToCollection(
  member: CollectionMember,
  target: string | BookmarkCollection,
  ownerPubkey: string,
  options: CollectionWriteOptions = {},
): Promise<CollectionWriteResult> {
  const owner = ownerPubkey.toLowerCase();
  const current = typeof target === 'string'
    ? findCollection(target)
    : target;
  const slug = collectionSlugFromInput(typeof target === 'string' ? target : target.slug);
  if (!slug) throw new Error('enter a collection name');

  const visibility = current?.visibility ?? options.visibility ?? 'public';
  const title = options.title?.trim() ||
    current?.title ||
    (typeof target === 'string' && target.trim() && collectionSlugFromInput(target) !== target.trim()
      ? target.trim()
      : collectionTitleFromSlug(slug));

  const base = current ?? emptyCollection(title || slug, owner, visibility);
  const next = upsertCollectionMember({
    ...base,
    slug,
    title,
    description: options.description ?? base.description,
    visibility,
    ownerPubkey: owner,
  }, member);

  const collection = next.visibility === 'private'
    ? { ...next, dTag: await privateCollectionDTag(slug) }
    : next;

  rememberOwnCollection(collection);
  const template = await buildCollectionEvent(collection, owner);
  const publish = publishEventQueued(template, owner, { failureSubject: 'collection' })
    .then((result) => {
      rememberOwnCollection({
        ...collection,
        eventId: result.eventId || collection.eventId,
        eventCreatedAt: template.created_at,
      });
      return result;
    })
    .catch((error) => {
      void refreshOwnCollections(owner);
      throw error;
    });

  return { slug, collection, publish };
}

function bookmarkToMember(bookmark: ParsedBookmark): CollectionMember {
  return {
    url: bookmark.url,
    title: bookmark.title && bookmark.title !== bookmark.url ? bookmark.title : undefined,
    addedAt: Math.floor(Date.now() / 1000),
  };
}

function findCollection(input: string): BookmarkCollection | null {
  const slug = collectionSlugFromInput(input);
  if (!slug) return null;
  return get(internal).find((collection) => collection.slug === slug) ?? null;
}

async function buildCollectionEvent(
  collection: BookmarkCollection,
  ownerPubkey: string,
): Promise<UnsignedEventTemplate> {
  if (collection.visibility === 'public') return buildPublicCollectionEvent(collection);
  const ndk = getNdk();
  if (!ndk.signer) throw new Error('No signer attached. Sign in first.');
  const me = ndk.getUser({ pubkey: ownerPubkey });
  const ciphertext = await withTimeout(
    ndk.signer.encrypt(me, JSON.stringify(privateCollectionPayload(collection)), 'nip44'),
    SIGNER_OP_TIMEOUT_MS,
    'private collection encrypt',
  );
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', collection.dTag || await privateCollectionDTag(collection.slug)],
      ['visibility', 'private'],
      ['member_count', String(collection.members.length)],
    ],
    content: ciphertext,
  };
}

async function decryptPrivateCollection(
  event: SignedEventLike,
  expectedOwnerPubkey: string,
): Promise<BookmarkCollection | null> {
  const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  if (!isPrivateCollectionDTag(dTag)) return null;
  if (event.pubkey.toLowerCase() !== expectedOwnerPubkey.toLowerCase()) return null;
  const ndk = getNdk();
  if (!ndk.signer) return null;
  let plaintext: string;
  try {
    const me = ndk.getUser({ pubkey: expectedOwnerPubkey });
    plaintext = await withTimeout(
      ndk.signer.decrypt(me, event.content, 'nip44'),
      SIGNER_OP_TIMEOUT_MS,
      'private collection decrypt',
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isValidPrivateCollectionPayload(parsed)) return null;
  return collectionFromPrivatePayload(parsed, event);
}

async function fetchDeepmarksCollectionEvents(ownerPubkey: string): Promise<SignedEventLike[]> {
  const ndk = getNdk();
  const relaySet = canonicalRelaySet();
  const events = await ndk.fetchEvents(
    {
      kinds: [KIND.privateBookmarkSet as unknown as NDKKind],
      authors: [ownerPubkey.toLowerCase()],
      limit: 300,
    },
    relaySet ? { groupable: false } : undefined,
    relaySet ?? undefined,
  );
  return Array.from(events)
    .map((event) => ndkEventAsSigned(event))
    .filter((event) => isDeepmarksCollectionDTag(event.tags.find((tag) => tag[0] === 'd')?.[1]));
}

function latestEventsByDTag(events: SignedEventLike[]): SignedEventLike[] {
  const byDTag = new Map<string, SignedEventLike>();
  for (const event of events) {
    const dTag = event.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
    if (!dTag) continue;
    const existing = byDTag.get(dTag);
    if (!existing || event.created_at > existing.created_at || (
      event.created_at === existing.created_at &&
      // NIP-01 tie-break: LOWEST id wins for replaceables. Keeping the
      // highest here made the client build on the copy the relay
      // discards (2026-08-23 review; matches bookmark-merge-core).
      event.id.localeCompare(existing.id) < 0
    )) {
      byDTag.set(dTag, event);
    }
  }
  return [...byDTag.values()];
}
