<script lang="ts">
  // Public profile view — avatar, display name, bio, LN address, NIP-05,
  // npub, and two tabs of saves:
  //
  //   bookmarks  — kind:39701 events published through Deepmarks (or any
  //                client that speaks NIP-B0). The native URL bookmark.
  //   posts      — kind:10003 / kind:30003 bookmark lists from other
  //                Nostr clients (Damus, Primal, Amethyst, etc.). Surfaces
  //                both r-tag URLs (rendered as bookmark rows) and e-tag
  //                note refs (rendered as collapsed note cards via
  //                NoteCard, content fetched on demand via
  //                event-resolver.ts).
  //
  // These kind:10003/30003 entries deliberately do NOT enter the site's
  // public popular / recent / network feeds — they stay profile-scoped so
  // the global firehose isn't flooded with personal reading lists.
  //
  // Routed by /u/[slug]; the param is one of:
  //   • a bech32 npub1…
  //   • a 64-char hex pubkey (legacy fallback)
  //   • a short deepmarks handle (lifetime-tier perk) — resolved at runtime
  //     via GET /account/username-lookup → pubkey.
  // Invalid / unknown slugs render a small "unknown user" placeholder
  // rather than throwing.

  import { page } from '$app/stores';
  import { nip19 } from 'nostr-tools';
  import { derived, writable, type Readable } from 'svelte/store';
  import Avatar from '$lib/components/Avatar.svelte';
  import LifetimeBadge from '$lib/components/LifetimeBadge.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import NoteCard from '$lib/components/NoteCard.svelte';
  import { getProfile } from '$lib/nostr/profiles';
  import { getUsername } from '$lib/nostr/username';
  import { api, ApiError } from '$lib/api/client';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import { fetchOwnPrivateSet, parsePrivateEntry } from '$lib/nostr/private-bookmarks';
  import { session, canSign } from '$lib/stores/session';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';

  /** A posts-tab entry — either an r-tag URL (rendered as a LandingFeedRow)
   *  or an e-tag note ref (rendered as a NoteCard). Merged + sorted by
   *  savedAt so the user sees one chronological stream of their Nostr
   *  bookmarks regardless of source format. */
  type PostEntry =
    | { kind: 'url'; data: ImportedUrlBookmark }
    | { kind: 'note'; data: ImportedNoteRef };

  type Tab = 'bookmarks' | 'posts';
  const tab = writable<Tab>('bookmarks');

  $: id = $page.params.slug;

  /** Synchronous pubkey resolution — handles npub + hex. Short handles are
   *  resolved async below and tracked separately so we only render the
   *  "unknown user" state once both paths have given up. */
  $: directPubkey = (() => {
    if (!id) return null;
    try {
      const d = nip19.decode(id);
      if (d.type === 'npub') return d.data as string;
    } catch { /* fall through to hex check */ }
    return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : null;
  })();

  /** Handle-resolved pubkey. null = not-yet-tried, undefined = definitively not found. */
  let handlePubkey: string | null | undefined = null;
  /** Last slug we kicked a lookup for. Comparing to this inside the
   *  `.then` callback lets us discard stale responses when the user
   *  navigates handles faster than the API responds. */
  let handleLookupFor = '';
  /** Non-404 lookup failure (network / 5xx). Rendered as a retry prompt
   *  rather than "unknown user", which would falsely imply the user
   *  doesn't exist. */
  let lookupError = '';

  $: if (id && !directPubkey && id !== handleLookupFor) {
    const lookingUp = id;
    handleLookupFor = lookingUp;
    handlePubkey = null;
    lookupError = '';
    api.username
      .lookup(lookingUp)
      .then((res) => {
        // Ignore stale responses from a previous slug.
        if (handleLookupFor !== lookingUp) return;
        handlePubkey = res.pubkey;
      })
      .catch((e) => {
        if (handleLookupFor !== lookingUp) return;
        if (e instanceof ApiError && e.status === 404) {
          handlePubkey = undefined;
        } else {
          lookupError = (e as Error).message || 'lookup failed';
          handlePubkey = undefined;
        }
      });
  }

  $: pubkey = directPubkey ?? (typeof handlePubkey === 'string' ? handlePubkey : null);
  /** True once every resolution path has returned. Prevents flashing
   *  "unknown user" while a handle lookup is still in flight. */
  $: resolving = !directPubkey && handleLookupFor === id && handlePubkey === null;

  $: npub = pubkey ? (() => {
    try { return nip19.npubEncode(pubkey); } catch { return id; }
  })() : id;

  $: profile = pubkey ? getProfile(pubkey) : null;
  $: handleStore = pubkey ? getUsername(pubkey) : null;

  $: feed = pubkey
    ? createBookmarkFeed({ authors: [pubkey], limit: 100 })
    : null;

  $: postUrls = pubkey
    ? createImportedBookmarksFeed({ authors: [pubkey], limit: 100 })
    : null;

  $: postNotes = pubkey
    ? createImportedNoteRefsFeed({ authors: [pubkey], limit: 100 })
    : null;

  // ── Private bookmarks (owner-only) ──────────────────────────────
  // Three-tier cache mirrors /app/+page.svelte: synchronous
  // localStorage prime + Dexie persistence + live decrypt gated on
  // canSign. Cache key shared with /app so a visit to either
  // surface fills the other.
  $: isOwner = !!pubkey && $session.pubkey === pubkey;

  const PRIVATE_LS_PREFIX = 'deepmarks-private-bookmarks:v3:';
  function lsLoadPrivate(pk: string): ParsedBookmark[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(PRIVATE_LS_PREFIX + pk);
      return raw ? (JSON.parse(raw) as ParsedBookmark[]) : [];
    } catch { return []; }
  }
  function lsSavePrivate(pk: string, list: ParsedBookmark[]): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(PRIVATE_LS_PREFIX + pk, JSON.stringify(list)); }
    catch { /* quota */ }
  }

  const privateBookmarks = writable<ParsedBookmark[]>([]);
  let lastFetchedPubkey: string | null = null;
  // Sync prime the moment we know the owner pubkey.
  $: if (isOwner && pubkey) {
    privateBookmarks.set(lsLoadPrivate(pubkey));
  }
  // Live decrypt only after the signer attaches.
  $: if (isOwner && pubkey && $canSign && pubkey !== lastFetchedPubkey) {
    lastFetchedPubkey = pubkey;
    void loadPrivate(pubkey);
  }
  // Reset when the visitor signs out / changes pubkey.
  $: if (!isOwner) {
    privateBookmarks.set([]);
    lastFetchedPubkey = null;
  }

  async function loadPrivate(pk: string): Promise<void> {
    try {
      const set = await fetchOwnPrivateSet(pk);
      const parsed: ParsedBookmark[] = [];
      const savedAt = Math.floor(Date.now() / 1000);
      for (const entry of set.entries) {
        const p = parsePrivateEntry(entry, pk, savedAt, '');
        if (p) parsed.push(p);
      }
      if (parsed.length > 0) {
        privateBookmarks.set(parsed);
        lsSavePrivate(pk, parsed);
      }
    } catch {
      /* keep cache */
    }
  }

  $: bookmarks = ((feed && pubkey)
    ? derived([feed ?? derived([], () => [] as ParsedBookmark[]), privateBookmarks], ([$pub, $priv]) => {
        // De-dup by URL — private wins (most recent intentional state).
        const byUrl = new Map<string, ParsedBookmark>();
        for (const b of $pub) byUrl.set(b.url, b);
        for (const b of $priv) byUrl.set(b.url, b);
        return [...byUrl.values()].sort((a, b) => b.savedAt - a.savedAt);
      })
    : derived([], () => [] as ParsedBookmark[])) as Readable<ParsedBookmark[]>;

  // Merge URL + note-ref streams, sort by savedAt desc.
  $: postsEntries = ((postUrls && postNotes)
    ? derived([postUrls, postNotes], ([$urls, $notes]) => {
        const merged: PostEntry[] = [
          ...$urls.map((u) => ({ kind: 'url' as const, data: u })),
          ...$notes.map((n) => ({ kind: 'note' as const, data: n })),
        ];
        merged.sort((a, b) => b.data.savedAt - a.data.savedAt);
        return merged;
      })
    : derived([], () => [] as PostEntry[])) as Readable<PostEntry[]>;

  $: pageTitle = `${$handleStore ?? $profile?.displayName ?? 'profile'} — Deepmarks`;
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<a href="/" class="back"><Logo size={20} flip /> back</a>

<header class="profile-head">
  {#if pubkey}
    <div class="avatar-wrap">
      <Avatar {pubkey} size={72} label={$profile?.displayName} />
      <span class="lifetime-overlay"><LifetimeBadge {pubkey} size={22} /></span>
    </div>
    <div class="meta">
      <h1>{$profile?.displayName ?? 'unnamed'}</h1>
      {#if $handleStore}
        <p class="handle">deepmarks.org/u/{$handleStore}</p>
      {/if}
      {#if $profile?.nip05}
        <p class="nip05">{$profile.nip05}</p>
      {/if}
      {#if $profile?.about}
        <p class="about">{$profile.about}</p>
      {/if}
      <p class="npub"><code>{npub}</code></p>
      {#if $profile?.lud16}
        <p class="ln"><span class="zap-icon">⚡</span> {$profile.lud16}</p>
      {/if}
    </div>
  {:else if resolving}
    <p class="unknown">looking up {id}…</p>
  {:else if lookupError}
    <p class="unknown">couldn't reach the server — <button type="button" class="retry" on:click={() => { handleLookupFor = ''; }}>retry</button></p>
  {:else}
    <p class="unknown">unknown user</p>
  {/if}
</header>

{#if pubkey}
  <section class="bookmarks">
    <div class="tab-row">
      <button
        type="button"
        class:active={$tab === 'bookmarks'}
        on:click={() => tab.set('bookmarks')}
      >
        bookmarks
        <span class="count">{$bookmarks.length}</span>
      </button>
      <button
        type="button"
        class:active={$tab === 'posts'}
        on:click={() => tab.set('posts')}
      >
        posts
        <span class="count">{$postsEntries.length}</span>
      </button>
    </div>

    {#if $tab === 'bookmarks'}
      {#if $bookmarks.length === 0}
        <p class="empty">{isOwner ? 'no bookmarks yet.' : 'no public bookmarks yet.'}</p>
      {:else}
        {#each $bookmarks as b (b.eventId)}
          <LandingFeedRow bookmark={b} />
        {/each}
      {/if}
    {:else}
      {#if $postsEntries.length === 0}
        <p class="empty">no posts bookmarked from social Nostr clients yet.</p>
      {:else}
        {#each $postsEntries as entry (entry.kind === 'url' ? `u:${entry.data.eventId}:${entry.data.url}` : `n:${entry.data.listEventId}:${entry.data.targetEventId}`)}
          {#if entry.kind === 'url'}
            <LandingFeedRow bookmark={entry.data} />
          {:else}
            <NoteCard targetEventId={entry.data.targetEventId} />
          {/if}
        {/each}
      {/if}
    {/if}
  </section>
{/if}

<Footer />

<style>
  .back {
    position: absolute;
    top: 20px;
    left: 24px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted) !important;
    font-size: 12px;
    text-decoration: none;
  }
  .back:hover {
    color: var(--coral) !important;
    text-decoration: none;
  }
  .profile-head {
    max-width: 640px;
    margin: 0 auto;
    padding: 60px 24px 24px;
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .lifetime-overlay {
    position: absolute;
    right: -4px;
    bottom: -4px;
    background: var(--paper);
    border-radius: 100%;
    padding: 2px;
    line-height: 0;
    box-shadow: 0 0 0 1px var(--rule);
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 26px;
    font-weight: 600;
    color: var(--ink-deep);
    margin: 0;
    letter-spacing: -0.3px;
  }
  .nip05 {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .handle {
    margin: 4px 0 0;
    color: var(--coral-deep);
    font-size: 13px;
    font-weight: 500;
    font-family: 'Courier New', monospace;
  }
  .about {
    margin: 10px 0 0;
    color: var(--ink);
    line-height: 1.55;
    font-size: 14px;
  }
  .npub {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--muted);
    word-break: break-all;
  }
  .npub code {
    font-family: 'Courier New', monospace;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .ln {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--zap);
  }
  .zap-icon {
    margin-right: 4px;
  }
  .unknown {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 0;
  }
  .retry {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--coral);
    cursor: pointer;
    text-decoration: underline;
  }
  .bookmarks {
    max-width: 640px;
    margin: 0 auto 60px;
    padding: 0 24px;
  }
  .tab-row {
    display: flex;
    gap: 20px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--ink-deep);
  }
  .tab-row button {
    background: transparent;
    border: 0;
    padding: 4px 0;
    font-family: inherit;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .tab-row button:hover {
    color: var(--ink);
  }
  .tab-row button.active {
    color: var(--ink-deep);
    font-weight: 600;
  }
  .tab-row .count {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    color: var(--muted);
    background: var(--paper-warm);
    border-radius: 100px;
    padding: 1px 7px;
    letter-spacing: 0;
  }
  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
</style>
