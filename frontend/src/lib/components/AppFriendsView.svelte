<script lang="ts">
  import { onDestroy } from 'svelte';
  import { derived, writable, type Readable } from 'svelte/store';
  import { Settings } from 'lucide-svelte';
  import AppSectionNav from './AppSectionNav.svelte';
  import AppActionBar from './AppActionBar.svelte';
  import BookmarkList from './BookmarkList.svelte';
  import FriendContactRow from './FriendContactRow.svelte';
  import Subheader from './Subheader.svelte';
  import { api, type AccountContact } from '$lib/api/client';
  import { contactList } from '$lib/nostr/contacts';
  import { friendPubkeys, friendsList, setFriends } from '$lib/nostr/friends';
  import { createBookmarkFeed } from '$lib/nostr/feed';
  import { createSocialLinkFeed } from '$lib/nostr/social-links';
  import {
    compareBookmarksNewest,
    compareBookmarksOldest,
    type ParsedBookmark,
  } from '$lib/nostr/bookmarks';
  import { tallyReceiptsInWindow } from '$lib/nostr/popularity';
  import { createZapReceiptFeed } from '$lib/nostr/zap-counts';
  import { resolveProfile } from '$lib/nostr/profiles';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { session } from '$lib/stores/session';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';

  type Sort = 'newest' | 'oldest' | 'title-az' | 'title-za';
  type FriendRowSort = 'name' | 'unchecked';

  const emptyBookmarks = writable<ParsedBookmark[]>([]);
  const zapReceipts = createZapReceiptFeed();
  let bookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let explicitBookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
  let socialLinkBookmarks: Readable<ParsedBookmark[]> = emptyBookmarks;
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
  let profileMap = new Map<string, { name?: string; nip05?: string }>();
  let profilePrimeKey = '';
  let contactsLoadedFor = '';
  let contactsLoading = false;
  let contactsError = '';
  let draftFriends = new Set<string>();
  let draftDirty = false;
  let draftSignature = '';
  let saving = false;
  let saveNotice = '';

  $: friendIds = [...$friendPubkeys];
  $: sortedFriendIds = [...friendIds].sort();
  $: explicitBookmarks = $session.pubkey && friendIds.length > 0
    ? createBookmarkFeed({ authors: friendIds, limit: 500 })
    : emptyBookmarks;
  $: socialLinkBookmarks = $session.pubkey && friendIds.length > 0
    ? createSocialLinkFeed({ authors: friendIds, limit: 500 })
    : emptyBookmarks;
  $: bookmarks = derived([explicitBookmarks, socialLinkBookmarks], ([$explicit, $social]) =>
    mergeFriendsFeed($explicit, $social),
  );
  $: if ($session.pubkey && contactsLoadedFor !== $session.pubkey) {
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
  $: sortedBookmarks = sortBookmarks(searchedBookmarks, sort);
  $: searchSummary = activeSearchQuery
    ? `${sortedBookmarks.length.toLocaleString()} ${sortedBookmarks.length === 1 ? 'match' : 'matches'}`
    : '';
  $: paginationKey = `friends:${sort}:${activeSearchQuery}:${sortedFriendIds.join(',')}`;
  $: friendsLoaded = $friendsList.loaded;
  $: friendsFeedUrl = $session.pubkey ? `/feed/friends/${$session.pubkey}.xml` : '';
  $: zapSatsByEventId = tallyReceiptsInWindow($zapReceipts, 0);

  onDestroy(() => {
    if (peopleSearchTimer) clearTimeout(peopleSearchTimer);
  });

  async function loadContacts(): Promise<void> {
    contactsLoading = true;
    contactsError = '';
    try {
      const res = await api.account.contacts();
      contacts = res.contacts;
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
    const profile = profileMap.get(contact.pubkey);
    return contact.name || profile?.name || contact.nip05 || profile?.nip05 || contact.deepmarksUsername || contact.pubkey;
  }

  function candidateMatches(contact: AccountContact, rawQuery: string): boolean {
    const q = rawQuery.trim().toLowerCase().replace(/^@/, '');
    if (!q) return true;
    return [
      contact.name,
      profileMap.get(contact.pubkey)?.name,
      contact.nip05,
      profileMap.get(contact.pubkey)?.nip05,
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
        const profile = await resolveProfile(pubkey).catch(() => null);
        return [pubkey, profile] as const;
      }));
      const next = new Map(profileMap);
      for (const [pubkey, profile] of resolved) {
        next.set(pubkey, {
          ...(profile?.name || profile?.displayName ? { name: profile.name || profile.displayName } : {}),
          ...(profile?.nip05 ? { nip05: profile.nip05 } : {}),
        });
      }
      profileMap = next;
    }
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

  function sortBookmarks(list: ParsedBookmark[], currentSort: Sort): ParsedBookmark[] {
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

  function mergeFriendsFeed(explicit: ParsedBookmark[], socialLinks: ParsedBookmark[]): ParsedBookmark[] {
    const byKey = new Map<string, ParsedBookmark>();
    for (const bookmark of socialLinks) {
      byKey.set(`${bookmark.curator}::${bookmark.url}`, bookmark);
    }
    // A real Deepmarks bookmark carries tags, description, archive state,
    // and an addressable kind:39701 coordinate. If the same friend also
    // pasted that URL into a social note, keep the explicit bookmark row.
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
    context="friends bookmarks"
    feedUrl={friendsFeedUrl}
    feedLabel="Deepmarks friends feed"
    sorts={[
      { label: 'newest',    id: 'newest',   current: sort === 'newest' },
      { label: 'oldest',    id: 'oldest',   current: sort === 'oldest' },
      { label: 'title a-z', id: 'title-az', current: sort === 'title-az' },
      { label: 'title z-a', id: 'title-za', current: sort === 'title-za' },
    ]}
    onSort={setSort}
  />

  <AppActionBar
    bind:searchOpen
    bind:searchQuery
    searchPlaceholder="search friends bookmarks..."
    resultSummary={searchSummary}
    addDisabled
    on:toggleSearch={() => (searchOpen = !searchOpen)}
  />
{/if}

<section class="friends-tools">
  <span class="selected-count">{friendIds.length.toLocaleString()} selected</span>
  {#if saveNotice}<span class:bad={saveNotice !== 'saved'}>{saveNotice}</span>{/if}
  <button
    type="button"
    class="manage-toggle"
    class:active={manageOpen}
    aria-label={manageOpen ? 'close friends manager' : 'manage friends'}
    title="manage friends"
    on:click={() => (manageOpen = !manageOpen)}
  >
    <Settings size={18} strokeWidth={2.2} />
  </button>
</section>

{#if manageOpen}
  <section class="friend-picker">
    <div class="picker-head">
      <div>
        <strong>friends</strong>
        <span>{draftFriends.size.toLocaleString()} selected</span>
      </div>
      <div class="picker-actions">
        <button type="button" on:click={addAll} disabled={contactRows.length === 0}>add all friends</button>
        <button type="button" on:click={clearAll} disabled={draftFriends.size === 0}>clear</button>
        <button type="button" class="primary" on:click={save} disabled={!draftDirty || saving}>
          {saving ? 'saving...' : 'save'}
        </button>
      </div>
    </div>
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
            on:toggle={(event) => toggleDraft(contact.pubkey, event.detail.checked)}
          />
        {/each}
      </div>
    {/if}
  </section>
{/if}

{#if !manageOpen}
  <BookmarkList
    bookmarks={sortedBookmarks}
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
  .selected-count {
    font-weight: 600;
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
  .manage-toggle.active,
  .picker-actions .primary {
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
