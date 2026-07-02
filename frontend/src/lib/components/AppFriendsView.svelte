<script lang="ts">
  import { onDestroy } from 'svelte';
  import { derived, writable, type Readable } from 'svelte/store';
  import { Settings } from 'lucide-svelte';
  import AppSectionNav from './AppSectionNav.svelte';
  import AppActionBar from './AppActionBar.svelte';
  import BookmarkList from './BookmarkList.svelte';
  import FriendContactRow from './FriendContactRow.svelte';
  import Subheader from './Subheader.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import { api, type AccountContact } from '$lib/api/client';
  import { contactList } from '$lib/nostr/contacts';
  import { friendPubkeys, friendsList, setFriends } from '$lib/nostr/friends';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { createSocialLinkFeed } from '$lib/nostr/social-links';
  import {
    createImportedBookmarksFeed,
    createImportedNoteRefsFeed,
    type ImportedNoteRef,
    type ImportedUrlBookmark,
  } from '$lib/nostr/imported-bookmarks';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark,
  } from '$lib/nostr/bookmarks';
  import {
    bookmarkZapTargetEventIds,
    sortBookmarksByZapSats,
  } from '$lib/nostr/bookmark-zap-target';
  import { nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import { KIND } from '$lib/nostr/kinds';
  import { tallyReceiptsInWindow, type ZapAggregate } from '$lib/nostr/popularity';
  import {
    createTargetedZapReceiptFeed,
    type ZapReceiptRecord,
  } from '$lib/nostr/zap-counts';
  import { isLikelyImageUrl, peekProfile, primeProfileCache, resolveProfile, type Profile } from '$lib/nostr/profiles';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { bookmarkToSearchResult, OVERLAY_RESULT_CAP } from '$lib/search/search-result';
  import { session } from '$lib/stores/session';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';
  import { ensureContacts, peekContacts } from '$lib/stores/contacts-cache';
  import { friendsFeedSettings } from '$lib/stores/friends-feed-settings';

  type Sort = 'newest' | 'zap-sats' | 'oldest' | 'title-az' | 'title-za';
  type FriendRowSort = 'name' | 'unchecked';
  const FEED_SETTLE_MS = 2_500;

  const emptyBookmarks = writable<ParsedBookmark[]>([]);
  const emptyImportedUrls = writable<ImportedUrlBookmark[]>([]);
  const emptyImportedNotes = writable<ImportedNoteRef[]>([]);
  const emptyZapReceipts = writable<ZapReceiptRecord[]>([]);
  let bookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let explicitBookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let importedUrlBookmarks: Readable<ImportedUrlBookmark[]> = writable<ImportedUrlBookmark[]>([]);
  let importedNoteRefs: Readable<ImportedNoteRef[]> = emptyImportedNotes;
  let importedNoteBookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let socialLinkBookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let targetedZapReceipts: Readable<ZapReceiptRecord[]> = emptyZapReceipts;
  let zapTargetSignature = '';
  let sort: Sort = 'newest';
  let friendRowSort: FriendRowSort = 'name';
  let searchOpen = false;
  let searchQuery = '';
  let manageOpen = false;
  let contacts: AccountContact[] = [];
  let friendSearchQuery = '';
  let peopleResults: AccountContact[] = [];
  let peopleSearchLoading = false;
  let peopleSearchError = '';
  let peopleSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let peopleSearchSeq = 0;
  let lastPeopleSearch = '';
  let profileMap = new Map<string, { name?: string; nip05?: string; picture?: string }>();
  let profilePrimeKey = '';
  let contactsLoadedFor = '';
  let contactsLoading = false;
  let contactsError = '';
  let draftFriends = new Set<string>();
  let draftDirty = false;
  let draftSignature = '';
  let saving = false;
  let saveNotice = '';
  let previousFeedBookmarks: ParsedBookmark[] = [];
  let feedSettling = false;
  let lastFriendsFeedKey = '';
  let feedSettleTimer: ReturnType<typeof setTimeout> | undefined;

  $: friendIds = [...$friendPubkeys];
  $: sortedFriendIds = [...friendIds].sort();
  $: explicitBookmarks = $session.pubkey && friendIds.length > 0
    ? createBookmarkFeed({ authors: friendIds, limit: 500 })
    : emptyBookmarks;
  $: importedUrlBookmarks = $session.pubkey && friendIds.length > 0
    ? createImportedBookmarksFeed({ authors: friendIds, limit: 500 })
    : emptyImportedUrls;
  $: importedNoteRefs = $session.pubkey && friendIds.length > 0
    ? createImportedNoteRefsFeed({ authors: friendIds, limit: 500 })
    : emptyImportedNotes;
  $: importedNoteBookmarks = derived(importedNoteRefs, (refs) =>
    refs.map(importedNoteRefToBookmark).filter((bookmark): bookmark is ParsedBookmark => bookmark !== null),
  );
  $: socialLinkBookmarks = $session.pubkey && friendIds.length > 0 && $friendsFeedSettings.includeSocialPosts
    ? createSocialLinkFeed({ authors: friendIds, limit: 500 })
    : emptyBookmarks;
  $: bookmarks = derived(
    [explicitBookmarks, importedUrlBookmarks, importedNoteBookmarks, socialLinkBookmarks],
    ([$explicit, $importedUrls, $importedNotes, $social]) =>
      mergeFriendsFeed($explicit, $importedUrls, $importedNotes, $social),
  );
  $: if ($session.pubkey && manageOpen && contactsLoadedFor !== $session.pubkey) {
    contactsLoadedFor = $session.pubkey;
    void loadContacts();
  }
  $: fallbackContacts = [...$contactList.contacts.values()].map((c) => ({
    pubkey: c.pubkey,
    npub: '',
    name: c.petname,
  }));
  $: contactRows = mergeContacts(contacts, fallbackContacts, $session.pubkey);
  $: friendSearch = friendSearchQuery.trim();
  $: visibleContactRows = friendSearch
    ? contactRows.filter((contact) => candidateMatches(contact, friendSearch))
    : contactRows;
  $: searchRows = friendSearch
    ? mergeContacts(visibleContactRows, peopleResults, $session.pubkey)
    : contactRows;
  $: sortedSearchRows = sortContactRows(searchRows, friendRowSort, draftFriends);
  $: profileCandidates = manageOpen ? searchRows.slice(0, 300) : [];
  $: nextProfilePrimeKey = profileCandidates.map((c) => c.pubkey).sort().join(',');
  $: if (nextProfilePrimeKey && nextProfilePrimeKey !== profilePrimeKey) {
    profilePrimeKey = nextProfilePrimeKey;
    void primeProfiles(profileCandidates);
  }
  $: if ($session.pubkey && friendSearch !== lastPeopleSearch) {
    lastPeopleSearch = friendSearch;
    schedulePeopleSearch(friendSearch);
  }
  $: currentFriendSignature = `${$session.pubkey ?? ''}:${sortedFriendIds.join(',')}`;
  $: if (!draftDirty && draftSignature !== currentFriendSignature) {
    draftFriends = new Set(friendIds);
    draftSignature = currentFriendSignature;
  }
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchedBookmarks = activeSearchQuery
    ? searchLocalBookmarks($bookmarks, activeSearchQuery, { limit: 10_000 })
    : $bookmarks;
  $: nextZapTargetIds = bookmarkZapTargetEventIds($bookmarks).sort();
  $: nextZapTargetSignature = nextZapTargetIds.join(',');
  $: if (nextZapTargetSignature !== zapTargetSignature) {
    zapTargetSignature = nextZapTargetSignature;
    targetedZapReceipts = nextZapTargetIds.length > 0
      ? createTargetedZapReceiptFeed({ targetEventIds: nextZapTargetIds })
      : emptyZapReceipts;
  }
  $: zapSatsByEventId = tallyReceiptsInWindow($targetedZapReceipts, 0);
  $: sortedBookmarks = sortBookmarks(searchedBookmarks, sort, zapSatsByEventId);
  $: overlaySearchResults = activeSearchQuery
    ? sortedBookmarks.slice(0, OVERLAY_RESULT_CAP).map(bookmarkToSearchResult)
    : [];
  $: friendsFeedKey = sortedFriendIds.join(',');
  $: if (friendsFeedKey !== lastFriendsFeedKey) {
    lastFriendsFeedKey = friendsFeedKey;
    startFeedSettleWindow();
  }
  $: if (!activeSearchQuery && sortedBookmarks.length > 0) {
    previousFeedBookmarks = sortedBookmarks;
    feedSettling = false;
    if (feedSettleTimer) {
      clearTimeout(feedSettleTimer);
      feedSettleTimer = undefined;
    }
  }
  $: displayedFriendBookmarks = !activeSearchQuery
    && feedSettling
    && friendIds.length > 0
    && sortedBookmarks.length === 0
    && previousFeedBookmarks.length > 0
      ? previousFeedBookmarks
      : sortedBookmarks;
  $: searchSummary = activeSearchQuery
    ? `${sortedBookmarks.length.toLocaleString()} ${sortedBookmarks.length === 1 ? 'match' : 'matches'}`
    : '';
  $: paginationKey = `friends:${sort}:${activeSearchQuery}:${sortedFriendIds.join(',')}:${$friendsFeedSettings.includeSocialPosts ? 'social' : 'bookmarks'}`;
  $: friendsLoaded = $friendsList.loaded;
  $: friendsFeedUrl = $session.pubkey ? `/feed/friends/${$session.pubkey}.xml` : '';

  onDestroy(() => {
    if (peopleSearchTimer) clearTimeout(peopleSearchTimer);
    if (feedSettleTimer) clearTimeout(feedSettleTimer);
  });

  function startFeedSettleWindow(): void {
    if (feedSettleTimer) clearTimeout(feedSettleTimer);
    feedSettling = previousFeedBookmarks.length > 0;
    feedSettleTimer = setTimeout(() => {
      feedSettling = false;
      feedSettleTimer = undefined;
    }, FEED_SETTLE_MS);
  }

  async function loadContacts(): Promise<void> {
    contactsLoading = true;
    contactsError = '';
    const cached = peekContacts();
    if (cached.length > 0) {
      contacts = cached;
      seedProfileMap(cached);
      contactsLoading = false;
    }
    try {
      const fresh = await ensureContacts();
      contacts = fresh;
      seedProfileMap(fresh);
    } catch (e) {
      contactsError = (e as Error).message || 'contacts unavailable';
    } finally {
      contactsLoading = false;
    }
  }

  function mergeContacts(
    apiContacts: AccountContact[],
    fallback: AccountContact[],
    ownerPubkey: string | null,
  ): AccountContact[] {
    const byPubkey = new Map<string, AccountContact>();
    for (const c of fallback) {
      const pubkey = c.pubkey.toLowerCase();
      if (pubkey && pubkey !== ownerPubkey) byPubkey.set(pubkey, { ...c, pubkey });
    }
    for (const c of apiContacts) {
      const pubkey = c.pubkey.toLowerCase();
      if (pubkey && pubkey !== ownerPubkey) byPubkey.set(pubkey, { ...byPubkey.get(pubkey), ...c, pubkey });
    }
    return [...byPubkey.values()].sort((a, b) =>
      labelFor(a).localeCompare(labelFor(b)) || a.pubkey.localeCompare(b.pubkey),
    );
  }

  function labelFor(contact: AccountContact): string {
    const profile = profileMap.get(contact.pubkey.toLowerCase());
    return contact.name || profile?.name || contact.nip05 || profile?.nip05 || contact.deepmarksUsername || contact.pubkey;
  }

  function candidateMatches(contact: AccountContact, rawQuery: string): boolean {
    const q = rawQuery.trim().toLowerCase().replace(/^@/, '');
    if (!q) return true;
    return [
      contact.name,
      profileMap.get(contact.pubkey.toLowerCase())?.name,
      contact.nip05,
      profileMap.get(contact.pubkey.toLowerCase())?.nip05,
      contact.deepmarksUsername,
      contact.npub,
      contact.pubkey,
    ].some((value) => value?.toLowerCase().includes(q));
  }

  async function primeProfiles(rows: AccountContact[]): Promise<void> {
    const pubkeys = [...new Set(rows.map((row) => row.pubkey.toLowerCase()))]
      .filter((pubkey) => /^[0-9a-f]{64}$/.test(pubkey) && !profileMap.has(pubkey));
    for (let i = 0; i < pubkeys.length; i += 12) {
      const batch = pubkeys.slice(i, i + 12);
      const resolved = await Promise.all(batch.map(async (pubkey) => {
        const cached = peekProfile(pubkey);
        if (cached) return [pubkey, cached] as const;
        const profile = await resolveProfile(pubkey).catch(() => null);
        return [pubkey, profile] as const;
      }));
      const next = new Map(profileMap);
      for (const [pubkey, profile] of resolved) {
        next.set(pubkey, {
          ...(profile?.name || profile?.displayName ? { name: profile.name || profile.displayName } : {}),
          ...(profile?.nip05 ? { nip05: profile.nip05 } : {}),
          ...(profile?.picture ? { picture: profile.picture } : {}),
        });
      }
      profileMap = next;
    }
  }

  function seedProfileMap(rows: AccountContact[]): void {
    primeProfileCache(rows.map(profileFromContact));
    const next = new Map(profileMap);
    for (const row of rows) {
      const pubkey = row.pubkey.toLowerCase();
      const cached = peekProfile(pubkey);
      const picture = isLikelyImageUrl(row.picture) ? row.picture : cached?.picture;
      const profile = {
        ...(row.name || cached?.name || cached?.displayName ? { name: row.name || cached?.name || cached?.displayName } : {}),
        ...(row.nip05 || cached?.nip05 ? { nip05: row.nip05 || cached?.nip05 } : {}),
        ...(picture ? { picture } : {}),
      };
      if (Object.keys(profile).length > 0) next.set(pubkey, profile);
    }
    profileMap = next;
  }

  function profileFromContact(contact: AccountContact): Profile | null {
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

  function schedulePeopleSearch(query: string): void {
    if (peopleSearchTimer) clearTimeout(peopleSearchTimer);
    peopleSearchError = '';
    if (query.trim().length < 2) {
      peopleResults = [];
      peopleSearchLoading = false;
      return;
    }
    peopleSearchLoading = true;
    const seq = ++peopleSearchSeq;
    peopleSearchTimer = setTimeout(() => {
      void searchPeople(query, seq);
    }, 250);
  }

  async function searchPeople(query: string, seq: number): Promise<void> {
    try {
      const res = await api.account.peopleSearch(query, 30);
      if (seq !== peopleSearchSeq) return;
      peopleResults = res.people;
      seedProfileMap(res.people);
    } catch (e) {
      if (seq !== peopleSearchSeq) return;
      peopleSearchError = (e as Error).message || 'people search unavailable';
      peopleResults = [];
    } finally {
      if (seq === peopleSearchSeq) peopleSearchLoading = false;
    }
  }

  function setSort(id: string): void {
    sort = id as Sort;
  }

  function titleFor(bookmark: ParsedBookmark): string {
    return (bookmark.title || bookmark.url).toLocaleLowerCase();
  }

  function sortBookmarks(
    list: ParsedBookmark[],
    currentSort: Sort,
    zapDataByEventId: Map<string, ZapAggregate> | null | undefined,
  ): ParsedBookmark[] {
    if (currentSort === 'zap-sats') return sortBookmarksByZapSats(list, zapDataByEventId);
    const sorted = [...list];
    switch (currentSort) {
      case 'newest':
        sorted.sort(compareBookmarksNewest);
        break;
      case 'oldest':
        sorted.sort(compareBookmarksOldest);
        break;
      case 'title-az':
        sorted.sort((a, b) => titleFor(a).localeCompare(titleFor(b)));
        break;
      case 'title-za':
        sorted.sort((a, b) => titleFor(b).localeCompare(titleFor(a)));
        break;
    }
    return sorted;
  }

  function importedNoteRefToBookmark(note: ImportedNoteRef): ParsedBookmark | null {
    const url = nostrNoteArchiveUrl(note.targetEventId);
    if (!url) return null;
    return {
      url,
      title: 'Nostr post',
      description: '',
      tags: [],
      archivedForever: false,
      savedAt: note.savedAt,
      eventCreatedAt: note.listCreatedAt,
      curator: note.curator,
      eventId: `nip51-note:${note.listEventId}:${note.targetEventId}`,
      source: 'nostr-note-link',
      sourceEventId: note.targetEventId,
      sourceEventKind: KIND.note,
      sourceContent: '',
    } as ParsedBookmark;
  }

  function mergeFriendsFeed(
    explicit: ParsedBookmark[],
    importedUrls: ParsedBookmark[],
    importedNotes: ParsedBookmark[],
    socialLinks: ParsedBookmark[],
  ): ParsedBookmark[] {
    const byKey = new Map<string, ParsedBookmark>();
    for (const bookmark of socialLinks) {
      byKey.set(`${bookmark.curator}::${bookmark.url}`, bookmark);
    }
    for (const bookmark of importedUrls) {
      byKey.set(`${bookmark.curator}::${bookmark.url}`, bookmark);
    }
    for (const bookmark of importedNotes) {
      byKey.set(`${bookmark.curator}::${bookmark.url}`, bookmark);
    }
    // A real Deepmarks bookmark carries tags, description, archive state, and
    // an addressable kind:39701 coordinate. If the same friend also saved that
    // URL through a NIP-51 list or pasted it into a note, keep the explicit row.
    for (const bookmark of explicit) {
      byKey.set(`${bookmark.curator}::${bookmark.url}`, bookmark);
    }
    return [...byKey.values()].sort(compareBookmarksNewest);
  }

  function sortContactRows(
    rows: AccountContact[],
    currentSort: FriendRowSort,
    selected: Set<string>,
  ): AccountContact[] {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      if (currentSort === 'unchecked') {
        const aSelected = selected.has(a.pubkey);
        const bSelected = selected.has(b.pubkey);
        if (aSelected !== bSelected) return aSelected ? 1 : -1;
      }
      return labelFor(a).localeCompare(labelFor(b)) || a.pubkey.localeCompare(b.pubkey);
    });
    return sorted;
  }

  function toggleDraft(pubkey: string, checked: boolean): void {
    const next = new Set(draftFriends);
    if (checked) next.add(pubkey);
    else next.delete(pubkey);
    draftFriends = next;
    draftDirty = true;
    saveNotice = '';
  }

  function addAll(): void {
    draftFriends = new Set(contactRows.map((c) => c.pubkey));
    draftDirty = true;
    saveNotice = '';
  }

  function clearAll(): void {
    draftFriends = new Set();
    draftDirty = true;
    saveNotice = '';
  }

  async function save(): Promise<void> {
    if (!$session.pubkey || saving) return;
    saving = true;
    saveNotice = '';
    try {
      await setFriends(draftFriends, $session.pubkey);
      draftDirty = false;
      draftSignature = `${$session.pubkey}:${[...draftFriends].sort().join(',')}`;
      saveNotice = 'saved';
      manageOpen = false;
    } catch (e) {
      saveNotice = (e as Error).message || 'save failed';
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head><title>friends — Deepmarks</title></svelte:head>

<AppSectionNav active="friends" bookmarksCount={$ownBookmarks.length} friendsCount={friendIds.length} />

{#if !manageOpen}
  <Subheader
    feedUrl={friendsFeedUrl}
    feedLabel="Deepmarks friends feed"
    sorts={[
      { label: 'newest',    id: 'newest',   current: sort === 'newest' },
      { label: 'oldest',    id: 'oldest',   current: sort === 'oldest' },
      { label: 'title a-z', id: 'title-az', current: sort === 'title-az' },
      { label: 'title z-a', id: 'title-za', current: sort === 'title-za' },
      { label: '⚡ sats',   id: 'zap-sats', current: sort === 'zap-sats' },
    ]}
    onSort={setSort}
  >
    <svelte:fragment slot="actions">
      <ToolbarActions
        {searchOpen}
        resultSummary={searchSummary}
        addDisabled
        on:toggleSearch={() => (searchOpen = !searchOpen)}
      >
        <svelte:fragment slot="actions">
          {#if saveNotice}<span class="save-notice" class:bad={saveNotice !== 'saved'}>{saveNotice}</span>{/if}
          <button
            type="button"
            class="manage-toggle"
            aria-label="manage friends"
            title="manage friends"
            on:click={() => (manageOpen = true)}
          >
            <Settings size={18} strokeWidth={2.2} />
          </button>
        </svelte:fragment>
      </ToolbarActions>
    </svelte:fragment>
  </Subheader>

  <AppActionBar
    bind:searchOpen
    bind:searchQuery
    panelOnly
    searchPlaceholder="search friends bookmarks..."
    addDisabled
    searchResults={overlaySearchResults}
  />
{/if}

{#if manageOpen}
  <section class="friends-tools">
    {#if saveNotice}<span class="save-notice" class:bad={saveNotice !== 'saved'}>{saveNotice}</span>{/if}
    <button
      type="button"
      class="manage-toggle active"
      aria-label="close friends manager"
      title="manage friends"
      on:click={() => (manageOpen = false)}
    >
      <Settings size={18} strokeWidth={2.2} />
    </button>
  </section>
{/if}

{#if manageOpen}
  <section class="friend-picker">
    <div class="picker-head">
      <div>
        <strong>friends</strong>
        <span>{draftFriends.size.toLocaleString()} friend{draftFriends.size === 1 ? '' : 's'}</span>
      </div>
      <div class="picker-actions">
        <button type="button" on:click={addAll} disabled={contactRows.length === 0}>add all friends</button>
        <button type="button" on:click={clearAll} disabled={draftFriends.size === 0}>clear</button>
        <button type="button" class="primary" on:click={save} disabled={!draftDirty || saving}>
          {saving ? 'saving...' : 'save'}
        </button>
      </div>
    </div>
    <label class="feed-option">
      <input
        type="checkbox"
        checked={$friendsFeedSettings.includeSocialPosts}
        on:change={(event) => friendsFeedSettings.update((settings) => ({
          ...settings,
          includeSocialPosts: (event.currentTarget as HTMLInputElement).checked,
        }))}
      />
      <span>
        <strong>social media posts</strong>
        <small>include raw links from friends' kind:1 notes; otherwise we just show bookmarks.</small>
      </span>
    </label>
    <label class="friend-search">
      <span>search</span>
      <input
        type="search"
        bind:value={friendSearchQuery}
        placeholder="contacts and Deepmarks users"
        autocomplete="off"
      />
    </label>
    <div class="friend-row-sort" aria-label="friend picker sort">
      <button type="button" class:active={friendRowSort === 'name'} on:click={() => (friendRowSort = 'name')}>
        name
      </button>
      <button type="button" class:active={friendRowSort === 'unchecked'} on:click={() => (friendRowSort = 'unchecked')}>
        unchecked first
      </button>
    </div>
    {#if contactsLoading && searchRows.length === 0}
      <p class="muted">loading contacts...</p>
    {:else if sortedSearchRows.length === 0 && !peopleSearchLoading}
      <p class="muted">{contactsError || 'no Nostr follows found yet'}</p>
    {:else}
      {#if peopleSearchLoading}<p class="muted">searching Deepmarks users...</p>{/if}
      {#if peopleSearchError}<p class="muted error">{peopleSearchError}</p>{/if}
      <div class="contact-grid">
        {#each sortedSearchRows as contact (contact.pubkey)}
          <FriendContactRow
            {contact}
            checked={draftFriends.has(contact.pubkey)}
            profileName={profileMap.get(contact.pubkey.toLowerCase())?.name}
            profileNip05={profileMap.get(contact.pubkey.toLowerCase())?.nip05}
            profilePicture={profileMap.get(contact.pubkey.toLowerCase())?.picture}
            on:toggle={(event) => toggleDraft(contact.pubkey, event.detail.checked)}
          />
        {/each}
      </div>
    {/if}
  </section>
{/if}

{#if !manageOpen}
  <BookmarkList
    bookmarks={displayedFriendBookmarks}
    loading={!friendsLoaded}
    emptyMessage={
      activeSearchQuery ? `no matches for "${activeSearchQuery}"`
      : friendsLoaded && friendIds.length === 0 ? 'choose friends from your Nostr follow list'
      : 'friends have not published bookmarks yet'
    }
    freezeFeed={false}
    showPendingBanner={false}
    tagScope="network"
    {zapSatsByEventId}
    paginationKey={paginationKey}
    freezeTagCloud
    richPreviews
    showAuthorAvatars
    renderNostrNoteBookmarks
  />
{/if}

<style>
  .friends-tools {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 24px 10px 62px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
    color: var(--muted);
    font-size: 12px;
  }
  .manage-toggle {
    width: 34px;
    height: 34px;
    margin-left: auto;
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 8px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .manage-toggle :global(svg) {
    display: block;
  }
  .manage-toggle.active {
    background: var(--coral-soft);
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .save-notice {
    color: var(--muted);
    font-size: 12px;
  }
  .picker-actions button {
    border: 1px solid var(--rule);
    background: var(--surface);
    color: var(--link);
    border-radius: 999px;
    padding: 7px 12px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .manage-toggle:hover,
  .picker-actions button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .manage-toggle:active,
  .picker-actions button:active:not(:disabled) {
    border-color: var(--coral);
    background: var(--coral-soft);
    color: var(--coral-deep);
  }
  .picker-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bad {
    color: var(--coral-deep);
  }
  .friend-picker {
    margin: 18px 24px 0 62px;
    max-width: 980px;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--link);
    background: var(--surface);
    padding: 14px;
  }
  .picker-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--rule);
  }
  .picker-head > div:first-child {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .picker-head strong {
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
  }
  .picker-head span,
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .muted.error {
    color: var(--coral-deep);
  }
  .picker-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .feed-option {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: flex-start;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink);
    cursor: pointer;
  }
  .feed-option input {
    margin-top: 2px;
    accent-color: var(--coral);
  }
  .feed-option span {
    display: grid;
    gap: 3px;
    min-width: 0;
  }
  .feed-option strong {
    color: var(--ink-deep);
    font-size: 13px;
  }
  .feed-option small {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }
  .friend-search {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    margin-top: 12px;
  }
  .friend-search span {
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .friend-search input {
    min-width: 0;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink);
    border-radius: 999px;
    padding: 8px 12px;
    font: inherit;
    font-size: 13px;
  }
  .friend-search input:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .friend-row-sort {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .friend-row-sort button {
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--muted);
    border-radius: 999px;
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .friend-row-sort button.active {
    border-color: var(--link);
    color: var(--link);
    background: rgba(27, 127, 183, 0.08);
  }
  .contact-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 8px;
    margin-top: 12px;
    max-height: 420px;
    overflow: auto;
  }
  @media (max-width: 720px) {
    .friends-tools {
      padding: 10px 16px;
    }
    .friend-picker {
      margin: 16px 20px 0;
    }
    .picker-head {
      align-items: flex-start;
      flex-direction: column;
    }
    .contact-grid {
      grid-template-columns: 1fr;
      max-height: none;
    }
  }
</style>
