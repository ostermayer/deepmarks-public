<script lang="ts">
  // /app/archives — list of the signed-in user's shipped archives.
  //
  // Same surface as the browser extension's "archived" tab in Recent.
  // Both consume GET /account/archives (NIP-98 auth via the user's
  // signer). Public archives link straight to the snapshot on Blossom.
  // Private archives ('🔒') decrypt client-side via the user's NIP-51
  // archive-key set: we look up the per-blob AES key in the set, fetch
  // the ciphertext, AES-GCM decrypt, and open the plaintext HTML in a
  // sandboxed blob: tab so nothing the page does can reach back into
  // deepmarks.org. The key never leaves the browser; the worker's
  // plaintext-key handoff happens once at archive-time and is wiped.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { writable } from 'svelte/store';
  import { Download } from 'lucide-svelte';
  import { canSign, isAuthenticated, session, sessionRestoring } from '$lib/stores/session';
  import { api, type ArchiveRecord } from '$lib/api/client';
  import { config } from '$lib/config';
  import { isNativeShell } from '$lib/native/runtime';
  import { downloadArchiveRecord, fetchArchiveBytes } from '$lib/archives/download';
  import { reconcileArchiveKeys } from '$lib/nostr/archive-keys';
  import ArchiveThumbnail from '$lib/components/ArchiveThumbnail.svelte';
  import Subheader from '$lib/components/Subheader.svelte';

  let archives: ArchiveRecord[] = [];
  let nativeShell = isNativeShell();
  let error: string | null = null;
  let loading = false;
  let loadedForPubkey: string | null = null;

  // Sort mirrors the bookmarks tab so users find the same options in
  // both places. Default = 'newest' (most recently archived first),
  // matching the bookmarks tab's default. Per-page state — changing
  // sort here doesn't affect /app/bookmarks and vice versa.
  type Sort = 'newest' | 'oldest' | 'title-az' | 'title-za';
  const sort = writable<Sort>('newest');
  function setSort(id: string): void { sort.set(id as Sort); }

  function hostForSort(rec: ArchiveRecord): string {
    try { return new URL(rec.url).hostname.replace(/^www\./, '').toLowerCase(); }
    catch { return rec.url.toLowerCase(); }
  }

  function sortArchives(list: ArchiveRecord[], currentSort: Sort): ArchiveRecord[] {
    const out = list.slice();
    switch (currentSort) {
      case 'newest':
        out.sort((a, b) => b.archivedAt - a.archivedAt);
        break;
      case 'oldest':
        out.sort((a, b) => a.archivedAt - b.archivedAt);
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

  $: sortedArchives = sortArchives(archives, $sort);
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
      archives = await api.archives.listAll();
      await reconcileArchiveKeys(archives, pubkey).catch(() => undefined);
    } catch (e) {
      if ($sessionRestoring) return;
      error = (e as Error).message ?? 'unknown error';
    } finally {
      loading = false;
    }
  }

  function publicUrl(rec: ArchiveRecord): string {
    return `${config.blossomUrl.replace(/\/$/, '')}/${encodeURIComponent(rec.blobHash)}`;
  }

  async function openPrivate(rec: ArchiveRecord): Promise<void> {
    if (!$session.pubkey) return;
    decryptState[rec.blobHash] = 'decrypting';
    decryptError[rec.blobHash] = '';
    try {
      const plaintext = await fetchArchiveBytes(rec, { pubkey: $session.pubkey });
      const blob = new Blob([plaintext as BlobPart], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after a generous load delay; the new tab keeps a
      // strong reference to the blob via its document.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      decryptState[rec.blobHash] = 'idle';
    } catch (e) {
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
</script>

<svelte:head><title>Archives — Deepmarks</title></svelte:head>

<div class="page">
  <header>
    <h1>archives</h1>
    <p class="lede">
      Permanent snapshots of pages you've bookmarked. Private archives are
      encrypted — only this {nativeShell ? 'device' : 'browser'} can open them.
    </p>
  </header>

  {#if archives.length > 0}
    <Subheader
      sorts={[
        { label: 'newest',    id: 'newest',   current: $sort === 'newest' },
        { label: 'oldest',    id: 'oldest',   current: $sort === 'oldest' },
        { label: 'title a-z', id: 'title-az', current: $sort === 'title-az' },
        { label: 'title z-a', id: 'title-za', current: $sort === 'title-za' },
      ]}
      onSort={setSort}
    />
  {/if}

  {#if error}
    <p class="error">couldn't load archives — {error}</p>
  {:else if archives.length === 0}
    <p class="muted">
      no archives yet. lifetime members can enable archive when saving a
      bookmark, or from the edit controls on an existing bookmark.
    </p>
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
              title="Private archive — click to decrypt + open the snapshot"
            >
              <ArchiveThumbnail thumbHash={a.thumbHash} tier={a.tier} url={a.url} />
              <div class="row-body">
                <div class="meta">
                  <span class="lock" aria-label="private archive">🔒</span>
                  <span class="host">{hostOf(a.url)}</span>
                  <span class="dot">·</span>
                  <span class="when">archived {relTime(a.archivedAt)}</span>
                  {#if a.source}
                    <span class="dot">·</span>
                    <span class="source">{a.source}</span>
                  {/if}
                  {#if decryptState[a.blobHash] === 'decrypting'}
                    <span class="dot">·</span>
                    <span class="muted">decrypting…</span>
                  {/if}
                </div>
                <div class="url">{a.url}</div>
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
                  <span class="when">archived {relTime(a.archivedAt)}</span>
                </div>
                <div class="url">{a.url}</div>
              </div>
            </a>
          {/if}
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
