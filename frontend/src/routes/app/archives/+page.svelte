<script lang="ts">
  // /app/archives — list of the signed-in user's shipped archives.
  //
  // Same surface as the browser extension's "archived" tab in Recent.
  // Both consume GET /account/archives (NIP-98 auth via the user's
  // signer). Public archives link straight to the snapshot on Blossom.
  // Private archives ('🔒') decrypt client-side via the user's NIP-51
  // archive-key set: we look up the final blob-hash key first, then
  // the provisional job key while reconciliation is catching up, fetch
  // the ciphertext, AES-GCM decrypt, and open the plaintext HTML in a
  // sandboxed blob: tab so nothing the page does can reach back into
  // deepmarks.org. The key never leaves the browser; the worker's
  // plaintext-key handoff happens once at archive-time and is wiped.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { writable } from 'svelte/store';
  import { Download } from 'lucide-svelte';
  import {
    canSign,
    currentSession,
    isAuthenticated,
    refreshBrowserExtensionSigner,
    session,
    sessionRestoring,
  } from '$lib/stores/session';
  import { api, type ArchiveRecord } from '$lib/api/client';
  import { config } from '$lib/config';
  import { isNativeShell } from '$lib/native/runtime';
  import {
    archiveMime,
    archiveTimelineAt,
    closeReservedArchiveWindow,
    downloadArchiveRecord,
    fetchArchiveBytes,
    openArchiveBlobUrl,
    reserveArchiveOpenWindow,
  } from '$lib/archives/download';
  import { auditArchiveKeyHealth } from '$lib/archives/key-health';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { ownBookmarks, refreshOwnBookmarks, rememberOwnBookmark } from '$lib/stores/own-bookmarks';
  import ArchiveThumbnail from '$lib/components/ArchiveThumbnail.svelte';
  import Subheader from '$lib/components/Subheader.svelte';
  import AppActionBar from '$lib/components/AppActionBar.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import BookmarkCard from '$lib/components/BookmarkCard.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import { searchLocalBookmarks } from '$lib/search/local-bookmark-search';
  import { bookmarkToSearchResult, OVERLAY_RESULT_CAP, type SearchResultItem } from '$lib/search/search-result';

  let archives: ArchiveRecord[] = [];
  let missingKeyArchives: ArchiveRecord[] = [];
  let nativeShell = isNativeShell();
  let error: string | null = null;
  let loading = false;
  let loadedForPubkey: string | null = null;
  let signerRecoveryTriedFor: string | null = null;
  let signerRecoveryBusy = false;
  let addOpen = false;
  let searchOpen = false;
  let searchQuery = '';
  let searchAllMine = false;

  // Sort mirrors the bookmarks tab so users find the same options in
  // both places. Default = 'newest' (most recently archived first),
  // matching the bookmarks tab's default. Per-page state — changing
  // sort here doesn't affect /app/bookmarks and vice versa.
  type Sort = 'newest' | 'oldest' | 'title-az' | 'title-za';
  const sort = writable<Sort>('newest');
  function setSort(id: string): void { sort.set(id as Sort); }

  function handleSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>) {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
  }

  function onSearchScope(event: CustomEvent<{ id: string; checked: boolean }>): void {
    if (event.detail.id === 'all-mine') searchAllMine = event.detail.checked;
  }

  function hostForSort(rec: ArchiveRecord): string {
    try { return new URL(rec.url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return rec.url.toLowerCase(); }
  }

  function sortArchives(list: ArchiveRecord[], currentSort: Sort): ArchiveRecord[] {
    const out = list.slice();
    switch (currentSort) {
      case 'newest':
        out.sort((a, b) => archiveTimelineAt(b) - archiveTimelineAt(a));
        break;
      case 'oldest':
        out.sort((a, b) => archiveTimelineAt(a) - archiveTimelineAt(b));
        break;
      case 'title-az':
        out.sort((a, b) => hostForSort(a).localeCompare(hostForSort(b)));
        break;
      case 'title-za':
        out.sort((a, b) => hostForSort(b).localeCompare(hostForSort(a)));
        break;
    }
    return out;
  }

  function savedAtForArchiveUrl(url: string, bookmarks: ParsedBookmark[]): number | undefined {
    const match = bookmarks.find((bookmark) => bookmark.url === url);
    return match?.savedAt && match.savedAt > 0 ? match.savedAt : undefined;
  }

  function archiveWithBookmarkTimeline(rec: ArchiveRecord, bookmarks: ParsedBookmark[]): ArchiveRecord {
    if (rec.bookmarkSavedAt && rec.bookmarkSavedAt > 0) return rec;
    const savedAt = savedAtForArchiveUrl(rec.url, bookmarks);
    if (!savedAt) return rec;
    return { ...rec, archivedAt: savedAt, bookmarkSavedAt: savedAt };
  }

  $: enrichedArchives = archives.map((archive) => archiveWithBookmarkTimeline(archive, $ownBookmarks));
  $: activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  $: searchedArchives = activeSearchQuery
    ? enrichedArchives.filter((archive) => archiveMatches(archive, activeSearchQuery))
    : enrichedArchives;
  $: sortedArchives = sortArchives(searchedArchives, $sort);
  $: bookmarkSearchResults = activeSearchQuery && searchAllMine
    ? searchLocalBookmarks($ownBookmarks, activeSearchQuery, { limit: 200 })
    : [];
  $: resultCount = sortedArchives.length + bookmarkSearchResults.length;
  $: searchSummary = activeSearchQuery
    ? `${resultCount.toLocaleString()} ${resultCount === 1 ? 'match' : 'matches'}`
    : '';
  $: overlaySearchResults = activeSearchQuery
    ? [
        ...sortedArchives.map(archiveToResult),
        ...bookmarkSearchResults.map(bookmarkToSearchResult),
      ].slice(0, OVERLAY_RESULT_CAP)
    : [];
  $: signerNeeded = $isAuthenticated && !$canSign && !$sessionRestoring;
  $: if (signerNeeded && $session.pubkey && signerRecoveryTriedFor !== $session.pubkey && !signerRecoveryBusy) {
    void recoverSigner($session.pubkey);
  }
  /** Per-row state for in-flight decrypts so the user gets feedback
   *  instead of a frozen-looking link. */
  const decryptState: Record<string, 'idle' | 'decrypting' | 'error'> = {};
  const decryptError: Record<string, string> = {};
  const downloadState: Record<string, 'idle' | 'downloading' | 'error'> = {};
  const downloadError: Record<string, string> = {};

  onMount(() => {
    if (!$isAuthenticated && !$session.signer) {
      void goto('/login?redirect=/app/archives');
    }
  });

  $: if ($session.pubkey && $canSign && loadedForPubkey !== $session.pubkey && !loading) {
    void loadArchives($session.pubkey);
  }

  async function loadArchives(pubkey: string): Promise<void> {
    loading = true;
    loadedForPubkey = pubkey;
    error = null;
    try {
      const records = await api.archives.listAll();
      const health = await auditArchiveKeyHealth(records, pubkey);
      archives = health.usable;
      // Archives whose AES key is unrecoverable on this device used to be
      // silently hidden — the user's paid archive just vanished. Surface
      // them; the backfill auto-queues replacements (webpage AND media).
      missingKeyArchives = health.missing;
      refreshOwnBookmarks();
    } catch (e) {
      if ($sessionRestoring) return;
      error = (e as Error).message ?? 'unknown error';
    } finally {
      loading = false;
    }
  }

  async function recoverSigner(pubkey: string): Promise<void> {
    signerRecoveryTriedFor = pubkey;
    signerRecoveryBusy = true;
    try {
      await session.rehydrate();
      if (currentSession().signer) return;
      await refreshBrowserExtensionSigner(pubkey);
    } finally {
      signerRecoveryBusy = false;
    }
  }

  function refreshPage(): void {
    window.location.reload();
  }

  async function signInAgain(): Promise<void> {
    await session.logout();
    await goto('/login?redirect=/app/archives');
  }

  function publicUrl(rec: ArchiveRecord): string {
    return `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(rec.blobHash)}`;
  }

  async function openPrivate(rec: ArchiveRecord): Promise<void> {
    if (!$session.pubkey) return;
    const reservedWindow = reserveArchiveOpenWindow(rec);
    decryptState[rec.blobHash] = 'decrypting';
    decryptError[rec.blobHash] = '';
    try {
      const plaintext = await fetchArchiveBytes(rec, { pubkey: $session.pubkey });
      const blob = new Blob([plaintext as BlobPart], {
        type: archiveMime(rec),
      });
      const url = URL.createObjectURL(blob);
      if (!openArchiveBlobUrl(url, rec, reservedWindow, { preferSameTab: nativeShell && isMediaArchive(rec) })) {
        URL.revokeObjectURL(url);
        throw new Error('archive decrypted, but this browser blocked opening it. Use download instead.');
      }
      // Revoke after a generous load delay; the new tab keeps a
      // strong reference to the blob via its document.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      decryptState[rec.blobHash] = 'idle';
    } catch (e) {
      closeReservedArchiveWindow(reservedWindow);
      decryptState[rec.blobHash] = 'error';
      decryptError[rec.blobHash] = (e as Error).message ?? 'failed to decrypt';
    }
  }

  async function downloadArchive(rec: ArchiveRecord): Promise<void> {
    downloadState[rec.blobHash] = 'downloading';
    downloadError[rec.blobHash] = '';
    try {
      await downloadArchiveRecord(rec, { pubkey: $session.pubkey });
      downloadState[rec.blobHash] = 'idle';
    } catch (e) {
      downloadState[rec.blobHash] = 'error';
      downloadError[rec.blobHash] = (e as Error).message ?? 'download failed';
    }
  }

  function relTime(unix: number): string {
    const diff = Math.floor(Date.now() / 1000) - unix;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
    return `${Math.floor(diff / (86400 * 365))}y ago`;
  }

  function hostOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }

  function archiveLabel(rec: ArchiveRecord): string {
    if (isMediaArchive(rec) && rec.videoTitle) {
      return rec.videoChannel ? `${rec.videoTitle} - ${rec.videoChannel}` : rec.videoTitle;
    }
    return rec.url;
  }

  function isMediaArchive(rec: ArchiveRecord): boolean {
    const kind = (rec.kind ?? '').toLowerCase();
    const contentType = (rec.contentType ?? '').toLowerCase();
    return kind === 'video' ||
      kind === 'youtube' ||
      kind === 'media' ||
      !!rec.videoId ||
      !!rec.videoContentKey ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('image/') ||
      (rec.files ?? []).some((file) => file.role === 'media');
  }

  function archiveTimePrefix(rec: ArchiveRecord): string {
    return rec.bookmarkSavedAt ? 'saved' : 'archived';
  }

  // An archive opens at its in-app detail page, which surfaces the snapshot
  // for both public and (decrypt-on-open) private tiers — one uniform target.
  function archiveToResult(rec: ArchiveRecord): SearchResultItem {
    const extras = rec.tier === 'private' ? '🔒 private' : rec.source ?? '';
    const subtitle = [hostOf(rec.url), extras].filter(Boolean).join(' · ');
    return {
      id: `archive:${rec.blobHash || rec.jobId}`,
      title: archiveLabel(rec),
      subtitle: subtitle || undefined,
      href: `/app/url/${encodeURIComponent(rec.url)}`,
      external: false,
    };
  }

  function archiveMatches(rec: ArchiveRecord, rawQuery: string): boolean {
    const haystack = [
      rec.url,
      archiveLabel(rec),
      hostOf(rec.url),
      rec.contentType ?? '',
      rec.source ?? '',
      rec.kind ?? '',
      rec.videoTitle ?? '',
      rec.videoChannel ?? '',
    ].join('\n').toLowerCase();
    return rawQuery.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
  }
</script>

<svelte:head><title>Archives — Deepmarks</title></svelte:head>

<div class="page">
  <header>
    <h1>archives</h1>
    <p class="lede">
      Permanent snapshots of pages you've bookmarked. Private archives are
      encrypted — only your signed-in Deepmarks devices can open them.
    </p>
  </header>

  <Subheader
    sorts={archives.length > 0 ? [
      { label: 'newest',    id: 'newest',   current: $sort === 'newest' },
      { label: 'oldest',    id: 'oldest',   current: $sort === 'oldest' },
      { label: 'title a-z', id: 'title-az', current: $sort === 'title-az' },
      { label: 'title z-a', id: 'title-za', current: $sort === 'title-za' },
    ] : []}
    onSort={setSort}
  >
    <svelte:fragment slot="actions">
      <ToolbarActions
        {addOpen}
        {searchOpen}
        resultSummary={searchSummary}
        addDisabled={nativeShell}
        on:toggleAdd={() => {
          addOpen = !addOpen;
          if (addOpen) searchOpen = false;
        }}
        on:toggleSearch={() => {
          searchOpen = !searchOpen;
          if (searchOpen) addOpen = false;
        }}
      />
    </svelte:fragment>
  </Subheader>

  <AppActionBar
    bind:searchOpen
    bind:searchQuery
    panelOnly
    searchPlaceholder="search your archives..."
    searchScopes={[{ id: 'all-mine', label: 'include all my bookmarks', checked: searchAllMine }]}
    compact={true}
    searchResults={overlaySearchResults}
    on:scope={onSearchScope}
  />

  {#if addOpen && !nativeShell}
    <div class="inline-save">
      <SaveBox on:saved={handleSaved} />
    </div>
  {/if}

  {#if activeSearchQuery && searchAllMine && bookmarkSearchResults.length > 0}
    <section class="bookmark-results" aria-label="bookmark matches">
      <div class="result-heading">
        <strong>bookmark matches</strong>
        <span>{bookmarkSearchResults.length.toLocaleString()}</span>
      </div>
      {#each bookmarkSearchResults as bookmark (bookmark.eventId)}
        <BookmarkCard {bookmark} />
      {/each}
    </section>
  {/if}

  {#if missingKeyArchives.length > 0}
    <div class="notice">
      <p>
        {missingKeyArchives.length} archive{missingKeyArchives.length === 1 ? '' : 's'}
        couldn't be decrypted on this device — the key isn't in your synced
        key set. replacement archives are queued automatically with fresh
        keys; the originals stay listed here until they're replaced.
      </p>
      <ul class="muted">
        {#each missingKeyArchives.slice(0, 10) as rec (rec.jobId)}
          <li>{rec.url}</li>
        {/each}
        {#if missingKeyArchives.length > 10}
          <li>…and {missingKeyArchives.length - 10} more</li>
        {/if}
      </ul>
    </div>
  {/if}

  {#if error}
    <p class="error">couldn't load archives — {error}</p>
  {:else if signerNeeded}
    <div class="notice">
      <p>
        {signerRecoveryBusy
          ? 'finishing sign-in so your archives can load...'
          : 'we could not finish loading your private archives. refresh this page first; if it still happens, sign in again.'}
      </p>
      {#if !signerRecoveryBusy}
        <div class="notice-actions">
          <button type="button" class="primary-action" on:click={refreshPage}>refresh page</button>
          <button type="button" class="secondary-action" on:click={signInAgain}>sign in again</button>
        </div>
      {/if}
    </div>
  {:else if loading && archives.length === 0}
    <p class="muted">loading archives...</p>
  {:else if archives.length === 0}
    <p class="muted">
      no archives yet. lifetime members can enable archive when saving a
      bookmark, or from the edit controls on an existing bookmark.
    </p>
  {:else if activeSearchQuery && resultCount === 0}
    <p class="muted">no matches for <code>{activeSearchQuery}</code></p>
  {:else}
    <ul class="archive-list">
      {#each sortedArchives as a (a.blobHash || a.jobId)}
        <li class="archive-item">
          {#if a.tier === 'private'}
            <button
              type="button"
              class="archive-row"
              on:click={() => openPrivate(a)}
              disabled={decryptState[a.blobHash] === 'decrypting'}
              title={isMediaArchive(a) ? 'Private media archive - click to decrypt + open' : 'Private archive - click to decrypt + open the snapshot'}
            >
              <ArchiveThumbnail thumbHash={a.thumbHash} tier={a.tier} url={a.url} />
              <div class="row-body">
                <div class="meta">
                  <span class="lock" aria-label="private archive">🔒</span>
                  <span class="host">{hostOf(a.url)}</span>
                  <span class="dot">·</span>
                  <span class="when">{archiveTimePrefix(a)} {relTime(archiveTimelineAt(a))}</span>
                  {#if a.source}
                    <span class="dot">·</span>
                    <span class="source">{a.source}</span>
                  {/if}
                  {#if decryptState[a.blobHash] === 'decrypting'}
                    <span class="dot">·</span>
                    <span class="muted">decrypting…</span>
                  {/if}
                </div>
                <div class="url">{archiveLabel(a)}</div>
                <code class="hash">blob {a.blobHash.slice(0, 12)}…</code>
                {#if decryptError[a.blobHash]}
                  <div class="row-error">↳ {decryptError[a.blobHash]}</div>
                {/if}
              </div>
            </button>
          {:else}
            <a
              class="archive-row"
              href={publicUrl(a)}
              target="_blank"
              rel="noreferrer"
              title="Open the archived snapshot"
            >
              <ArchiveThumbnail thumbHash={a.thumbHash} tier={a.tier} url={a.url} />
              <div class="row-body">
                <div class="meta">
                  <span class="host">{hostOf(a.url)}</span>
                  <span class="dot">·</span>
                  <span class="when">{archiveTimePrefix(a)} {relTime(archiveTimelineAt(a))}</span>
                </div>
                <div class="url">{a.url}</div>
              </div>
            </a>
          {/if}
          {#if !nativeShell || isMediaArchive(a)}
            <button
              type="button"
              class="icon-action"
              on:click={() => downloadArchive(a)}
              disabled={downloadState[a.blobHash] === 'downloading'}
              title="Download this archived page"
              aria-label="download archived page"
            >
              <Download size={16} strokeWidth={2.2} />
            </button>
            {#if downloadError[a.blobHash]}
              <div class="row-error download-error">↳ {downloadError[a.blobHash]}</div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); margin: 0 0 8px; letter-spacing: -0.4px; }
  .lede { color: var(--ink); font-size: 14px; line-height: 1.55; margin: 0 0 24px; }
  .muted { color: var(--muted); font-size: 13px; }
  .error { color: var(--coral-deep); font-size: 13px; }
  .notice {
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    padding: 14px;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.5;
  }
  .notice p { margin: 0; }
  .notice-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .notice-actions button {
    border-radius: 7px;
    padding: 8px 12px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .primary-action {
    border: 1px solid var(--coral);
    background: var(--coral);
    color: white;
  }
  .secondary-action {
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink);
  }
  .inline-save {
    margin: 10px 0 16px;
  }
  .bookmark-results {
    margin: 10px 0 18px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
  }
  .result-heading {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 6px;
    color: var(--ink-deep);
    font-size: 13px;
  }
  .result-heading span {
    color: var(--muted);
    font-size: 12px;
  }
  .archive-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .archive-item {
    display: flex;
    align-items: stretch;
    gap: 8px;
    flex-wrap: wrap;
  }
  .archive-row {
    display: flex; gap: 12px; align-items: stretch;
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid var(--rule); border-radius: 8px;
    background: var(--surface); text-decoration: none; color: inherit;
    transition: border-color 120ms;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .icon-action {
    width: 42px;
    flex: 0 0 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    color: var(--archive);
    cursor: pointer;
  }
  .icon-action:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral);
  }
  .icon-action:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .icon-action :global(svg) { display: block; }
  .archive-row .row-body { flex: 1; min-width: 0; align-self: center; }
  .archive-row:hover:not(:disabled) { border-color: var(--coral); }
  .archive-row:disabled { opacity: 0.7; cursor: progress; }
  .row-error {
    margin-top: 6px;
    color: #a33;
    font-size: 12px;
    line-height: 1.4;
  }
  .download-error {
    flex-basis: 100%;
    margin: -2px 0 4px 14px;
  }
  .meta { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .meta .host { font-weight: 600; color: var(--ink-deep); }
  .meta .dot { opacity: 0.5; }
  .meta .lock { font-size: 13px; }
  .url { color: var(--ink); font-size: 13px; word-break: break-all; margin-top: 4px; }
  .hash {
    display: inline-block; margin-top: 4px;
    font-family: 'Courier New', monospace; font-size: 11px;
    color: var(--muted);
  }
</style>
