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
  import { isAuthenticated, session } from '$lib/stores/session';
  import { api, type ArchiveRecord } from '$lib/api/client';
  import { config } from '$lib/config';
  import { getArchiveKeyMap, decryptArchiveBlob } from '$lib/nostr/archive-keys';

  let archives: ArchiveRecord[] | null = null;
  let error: string | null = null;
  let loading = true;
  /** Per-row state for in-flight decrypts so the user gets feedback
   *  instead of a frozen-looking link. */
  const decryptState: Record<string, 'idle' | 'decrypting' | 'error'> = {};
  const decryptError: Record<string, string> = {};

  onMount(async () => {
    if (!$isAuthenticated && !$session.signer) {
      void goto('/login?next=/app/archives');
      return;
    }
    try {
      archives = await api.archives.list();
    } catch (e) {
      error = (e as Error).message ?? 'unknown error';
    } finally {
      loading = false;
    }
  });

  function publicUrl(rec: ArchiveRecord): string {
    return `${config.blossomUrl}/${encodeURIComponent(rec.blobHash)}`;
  }

  async function openPrivate(rec: ArchiveRecord): Promise<void> {
    if (!$session.pubkey) return;
    decryptState[rec.blobHash] = 'decrypting';
    decryptError[rec.blobHash] = '';
    try {
      const map = await getArchiveKeyMap($session.pubkey);
      const key = map[rec.blobHash];
      if (!key) {
        throw new Error(
          'no decryption key in your relay set — open the snapshot once from the deepmarks browser extension to seed the key.',
        );
      }
      const res = await fetch(publicUrl(rec));
      if (!res.ok) throw new Error(`blossom fetch ${res.status}`);
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      const plaintext = await decryptArchiveBlob(ciphertext, key);
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
      pages you've paid to archive forever, snapshotted by the deepmarks worker
      and pinned on Blossom. private archives are encrypted to your nsec —
      decrypting them in-browser is shipping next.
    </p>
  </header>

  {#if loading}
    <p class="muted">loading your archives…</p>
  {:else if error}
    <p class="error">couldn't load archives — {error}</p>
  {:else if !archives || archives.length === 0}
    <p class="muted">
      no archives yet. toggle "Archive forever" when saving a bookmark, or
      tap the pay-to-archive option on any existing bookmark.
    </p>
  {:else}
    <ul class="archive-list">
      {#each archives as a (a.blobHash || a.jobId)}
        <li>
          {#if a.tier === 'private'}
            <button
              type="button"
              class="archive-row"
              on:click={() => openPrivate(a)}
              disabled={decryptState[a.blobHash] === 'decrypting'}
              title="Private archive — click to decrypt + open the snapshot"
            >
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
            </button>
          {:else}
            <a
              class="archive-row"
              href={publicUrl(a)}
              target="_blank"
              rel="noreferrer"
              title="Open the archived snapshot"
            >
              {#if a.thumbHash}
                <img
                  class="thumb"
                  src={`${config.blossomUrl}/${encodeURIComponent(a.thumbHash)}`}
                  alt=""
                  loading="lazy"
                />
              {/if}
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
  .archive-row {
    display: flex; gap: 12px; align-items: stretch;
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--rule); border-radius: 8px;
    background: var(--surface); text-decoration: none; color: inherit;
    transition: border-color 120ms;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .archive-row .row-body { flex: 1; min-width: 0; }
  .thumb {
    width: 96px;
    height: 64px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
    background: var(--paper-warm);
  }
  @media (max-width: 480px) {
    .thumb { width: 72px; height: 48px; }
  }
  .archive-row:hover:not(:disabled) { border-color: var(--coral); }
  .archive-row:disabled { opacity: 0.7; cursor: progress; }
  .row-error {
    margin-top: 6px;
    color: #a33;
    font-size: 12px;
    line-height: 1.4;
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
