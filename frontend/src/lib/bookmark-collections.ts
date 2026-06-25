import { KIND } from './nostr/kinds.js';
import {
  NIP89_CLIENT_TAG,
  assertSafeBookmarkUrl,
  type ParsedBookmark,
  type SignedEventLike,
  type UnsignedEventTemplate,
} from './nostr/bookmarks.js';
import { isPrivateBookmark } from './nostr/bookmark-privacy.js';

export const PUBLIC_COLLECTION_PREFIX = 'deepmarks-collection:';
export const PRIVATE_COLLECTION_PREFIX = 'deepmarks-collection-private:';

export type CollectionVisibility = 'public' | 'private';

export interface CollectionMember {
  url: string;
  title?: string;
  addedAt?: number;
}

export interface BookmarkCollection {
  slug: string;
  title: string;
  description?: string;
  visibility: CollectionVisibility;
  count: number;
  publicCount: number;
  privateCount: number;
  members: CollectionMember[];
  urls: string[];
  dTag: string;
  ownerPubkey: string;
  eventId?: string;
  eventCreatedAt?: number;
}

export interface PrivateCollectionPayload {
  slug: string;
  title?: string;
  description?: string;
  members: CollectionMember[];
}

export function collectionSlugFromInput(input: string): string {
  return input
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Backwards-compatible name for callers that still normalize a route param.
export const collectionSlugFromTag = collectionSlugFromInput;

export function collectionTitleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .join(' ') || 'collection';
}

export function publicCollectionDTag(slugOrInput: string): string {
  const slug = collectionSlugFromInput(slugOrInput);
  if (!slug) throw new Error('enter a collection name');
  return `${PUBLIC_COLLECTION_PREFIX}${slug}`;
}

export async function privateCollectionDTag(slugOrInput: string): Promise<string> {
  const slug = collectionSlugFromInput(slugOrInput);
  if (!slug) throw new Error('enter a collection name');
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(slug));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${PRIVATE_COLLECTION_PREFIX}${hex}`;
}

export function collectionSlugFromDTag(dTag: string): string {
  if (!dTag.startsWith(PUBLIC_COLLECTION_PREFIX)) return '';
  return collectionSlugFromInput(dTag.slice(PUBLIC_COLLECTION_PREFIX.length));
}

export function isDeepmarksCollectionDTag(dTag: string | undefined): boolean {
  return !!dTag && (
    dTag.startsWith(PUBLIC_COLLECTION_PREFIX) ||
    dTag.startsWith(PRIVATE_COLLECTION_PREFIX)
  );
}

export function isPublicCollectionDTag(dTag: string | undefined): boolean {
  return !!dTag && dTag.startsWith(PUBLIC_COLLECTION_PREFIX);
}

export function isPrivateCollectionDTag(dTag: string | undefined): boolean {
  return !!dTag && dTag.startsWith(PRIVATE_COLLECTION_PREFIX);
}

export function parsePublicCollectionEvent(event: SignedEventLike): BookmarkCollection | null {
  if (event.kind !== KIND.privateBookmarkSet) return null;
  const dTag = tagValue(event.tags, 'd') ?? '';
  const slug = collectionSlugFromDTag(dTag);
  if (!slug) return null;
  const members = membersFromTags(event.tags);
  return collectionFromParts({
    slug,
    title: tagValue(event.tags, 'title') || collectionTitleFromSlug(slug),
    description: tagValue(event.tags, 'summary') || tagValue(event.tags, 'description') || undefined,
    visibility: 'public',
    members,
    dTag,
    ownerPubkey: event.pubkey.toLowerCase(),
    eventId: event.id,
    eventCreatedAt: event.created_at,
  });
}

export function collectionFromPrivatePayload(
  payload: PrivateCollectionPayload,
  event: SignedEventLike,
): BookmarkCollection | null {
  const dTag = tagValue(event.tags, 'd') ?? '';
  if (!isPrivateCollectionDTag(dTag)) return null;
  const slug = collectionSlugFromInput(payload.slug);
  if (!slug) return null;
  return collectionFromParts({
    slug,
    title: payload.title || collectionTitleFromSlug(slug),
    description: payload.description,
    visibility: 'private',
    members: normalizeMembers(payload.members),
    dTag,
    ownerPubkey: event.pubkey.toLowerCase(),
    eventId: event.id,
    eventCreatedAt: event.created_at,
  });
}

export function isValidPrivateCollectionPayload(value: unknown): value is PrivateCollectionPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PrivateCollectionPayload>;
  if (typeof candidate.slug !== 'string') return false;
  if (candidate.title !== undefined && typeof candidate.title !== 'string') return false;
  if (candidate.description !== undefined && typeof candidate.description !== 'string') return false;
  if (!Array.isArray(candidate.members)) return false;
  return candidate.members.every((member) => (
    !!member &&
    typeof member === 'object' &&
    typeof (member as CollectionMember).url === 'string' &&
    ((member as CollectionMember).title === undefined || typeof (member as CollectionMember).title === 'string') &&
    ((member as CollectionMember).addedAt === undefined || Number.isSafeInteger((member as CollectionMember).addedAt))
  ));
}

export function buildPublicCollectionEvent(collection: BookmarkCollection): UnsignedEventTemplate {
  if (collection.visibility !== 'public') throw new Error('public collection event requires public visibility');
  const slug = collectionSlugFromInput(collection.slug || collection.title);
  if (!slug) throw new Error('enter a collection name');
  const tags: string[][] = [
    ['d', publicCollectionDTag(slug)],
    ['title', collection.title || collectionTitleFromSlug(slug)],
    ['visibility', 'public'],
  ];
  if (collection.description) tags.push(['summary', collection.description]);
  for (const member of normalizeMembers(collection.members)) {
    tags.push(memberTag(member));
  }
  tags.push(NIP89_CLIENT_TAG);
  return {
    kind: KIND.privateBookmarkSet,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

export function privateCollectionPayload(collection: BookmarkCollection): PrivateCollectionPayload {
  return {
    slug: collection.slug,
    title: collection.title,
    description: collection.description,
    members: normalizeMembers(collection.members),
  };
}

export function emptyCollection(
  slugOrTitle: string,
  ownerPubkey: string,
  visibility: CollectionVisibility = 'public',
): BookmarkCollection {
  const slug = collectionSlugFromInput(slugOrTitle);
  if (!slug) throw new Error('enter a collection name');
  const title = slugOrTitle.trim() || collectionTitleFromSlug(slug);
  return collectionFromParts({
    slug,
    title: title === slug ? collectionTitleFromSlug(slug) : title,
    visibility,
    members: [],
    dTag: visibility === 'public' ? publicCollectionDTag(slug) : '',
    ownerPubkey: ownerPubkey.toLowerCase(),
  });
}

export function upsertCollectionMember(
  collection: BookmarkCollection,
  member: CollectionMember,
): BookmarkCollection {
  const normalized = normalizeMember(member);
  if (!normalized) return collection;
  const members = normalizeMembers([
    normalized,
    ...collection.members.filter((existing) => existing.url !== normalized.url),
  ]);
  return collectionFromParts({
    ...collection,
    members,
  });
}

export function bookmarksForCollection(
  bookmarks: ParsedBookmark[],
  collection: BookmarkCollection | null | undefined,
  visibility: 'all' | 'public' | 'private' = 'all',
): ParsedBookmark[] {
  if (!collection) return [];
  const urls = new Set(collection.urls);
  if (urls.size === 0) return [];
  return bookmarks.filter((bookmark) => {
    if (!urls.has(bookmark.url)) return false;
    const privateBookmark = isPrivateBookmark(bookmark);
    if (visibility === 'public' && privateBookmark) return false;
    if (visibility === 'private' && !privateBookmark) return false;
    return true;
  });
}

export function mergeCollectionLists(...lists: BookmarkCollection[][]): BookmarkCollection[] {
  const byKey = new Map<string, BookmarkCollection>();
  for (const collection of lists.flat()) {
    const key = `${collection.ownerPubkey}:${collection.slug}`;
    const existing = byKey.get(key);
    if (!existing || collectionReplaceTime(collection) > collectionReplaceTime(existing)) {
      byKey.set(key, collection);
    }
  }
  return sortCollections([...byKey.values()]);
}

export function sortCollections(collections: BookmarkCollection[]): BookmarkCollection[] {
  return [...collections].sort((a, b) =>
    b.count - a.count ||
    collectionTitle(a).localeCompare(collectionTitle(b)) ||
    a.slug.localeCompare(b.slug),
  );
}

function collectionTitle(collection: BookmarkCollection): string {
  return collection.title || collectionTitleFromSlug(collection.slug);
}

function collectionReplaceTime(collection: BookmarkCollection): number {
  return collection.eventCreatedAt ?? 0;
}

function collectionFromParts(input: Omit<BookmarkCollection, 'count' | 'publicCount' | 'privateCount' | 'urls'>): BookmarkCollection {
  const members = normalizeMembers(input.members);
  const count = members.length;
  return {
    ...input,
    ownerPubkey: input.ownerPubkey.toLowerCase(),
    title: input.title || collectionTitleFromSlug(input.slug),
    members,
    urls: members.map((member) => member.url),
    count,
    publicCount: input.visibility === 'public' ? count : 0,
    privateCount: input.visibility === 'private' ? count : 0,
  };
}

function membersFromTags(tags: string[][]): CollectionMember[] {
  return normalizeMembers(tags.flatMap((tag) => {
    if (tag[0] !== 'r') return [];
    return [{
      url: tag[1] ?? '',
      title: tag[2] || undefined,
      addedAt: parseAddedAt(tag[3]),
    }];
  }));
}

function normalizeMembers(members: CollectionMember[]): CollectionMember[] {
  const byUrl = new Map<string, CollectionMember>();
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized) continue;
    byUrl.set(normalized.url, normalized);
  }
  return [...byUrl.values()].sort((a, b) =>
    (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.url.localeCompare(b.url),
  );
}

function normalizeMember(member: CollectionMember): CollectionMember | null {
  const url = safeHttpUrl(member.url);
  if (!url) return null;
  return {
    url,
    title: member.title?.trim() || undefined,
    addedAt: member.addedAt && Number.isSafeInteger(member.addedAt) && member.addedAt > 0
      ? member.addedAt
      : undefined,
  };
}

function memberTag(member: CollectionMember): string[] {
  assertSafeBookmarkUrl(member.url);
  const tag = ['r', member.url];
  if (member.title) tag.push(member.title);
  else if (member.addedAt) tag.push('');
  if (member.addedAt) tag.push(String(member.addedAt));
  return tag;
}

function safeHttpUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return raw;
  } catch {
    return '';
  }
}

function parseAddedAt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}
