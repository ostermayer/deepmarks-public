<script lang="ts">
  import { onDestroy } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { Archive, Download } from 'lucide-svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import type { ArchiveRecord } from '$lib/api/client';
  import { canSign, session } from '$lib/stores/session';
  import { getProfile } from '$lib/nostr/profiles';
  import { myArchives } from '$lib/stores/my-archives';
  import { downloadArchiveRecord } from '$lib/archives/download';
  import { getArchiveKeyMap, getPendingArchiveKey, decryptArchiveBlob } from '$lib/nostr/archive-keys';
  import { relativeTime } from '$lib/util/time';
  import { config } from '$lib/config';
  import { isNativeShell } from '$lib/native/runtime';
  import Favicon from './Favicon.svelte';
  import ZapDialog from './ZapDialog.svelte';
  import BookmarkEditForm from './BookmarkEditForm.svelte';
  import PostToNostrAction from './PostToNostrAction.svelte';
  import { toggleReadLater } from '$lib/nostr/toggle-read-later';

  export let bookmark: ParsedBookmark;
  /** Caller-supplied override (rare — most callers let us resolve from
   *  the kind:0 profile). Falls through to displayName → short npub → hex. */
  export let curatorName: string = '';
  export let saveCount: number | undefined = undefined;
  export let zapSats: number = 0;
  /** True when the row came from the user's encrypted NIP-51 private set
   *  rather than a kind:39701. Drives the 🔒/🌍 indicator on owner rows.
   *  Auto-derived from the bookmark's eventId prefix when not passed
   *  explicitly: parsePrivateEntry stamps eventId with `private:<url>`
   *  for NIP-51 entries, kind:39701 events keep their hex id. Letting
   *  the card self-classify means callers don't have to plumb the
   *  flag through every list — important because BookmarkList didn't,
   *  and /app was rendering every row as 'public' regardless of source. */
  export let isPrivate: boolean | undefined = undefined;

  $: derivedIsPrivate = isPrivate ?? bookmark.eventId.startsWith('private:');
  $: isReadLater = bookmark.tags.includes('toread');
  $: visibleTags = bookmark.tags.filter((t) => t !== 'toread');

  let togglingReadLater = false;
  function onToggleReadLater() {
    if (!$session.pubkey) return;
    // Optimistic toggle — synchronous. The previous version dynamic-
    // imported the helper and disabled the button until the publish
    // resolved, which meant the row's highlight stayed stuck for
    // seconds before the user could toggle back. Static import +
    // never-gate-the-UI gives same-tick visual feedback and lets a
    // user tap "read later" then "read" in quick succession; each
    // tap flips the cache immediately and queues a publish.
    let result;
    try {
      result = toggleReadLater(bookmark, $session.pubkey);
    } catch (e) {
      alert(`couldn't update: ${(e as Error).message ?? 'unknown'}`);
      return;
    }
    // Light spinner ONLY for the currently-firing publish — does not
    // block input. If the user toggles again mid-publish, the new
    // optimistic update wins and the in-flight publish becomes a
    // no-op once it resolves (its rememberOwnBookmark would be the
    // older state, but the savedAt-based upsert keeps the newer
    // value).
    togglingReadLater = true;
    result.publish
      .catch((e) => {
        alert(`saved locally, relay sync failed: ${(e as Error).message ?? 'unknown'}`);
      })
      .finally(() => {
        togglingReadLater = false;
      });
  }

  let zapOpen = false;
  let zapFlash = false;
  let zapFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let editing = false;
  let hidden = false;
  $: isOwner = $session.pubkey === bookmark.curator;

  // Resolve the curator's kind:0 profile once and react when it lands.
  // Without this the by-line shows a truncated hex, which is what users
  // saw on /app/recent + /app/network.
  $: profile = getProfile(bookmark.curator);
  $: resolvedLabel = curatorName || resolveLabel($profile?.displayName, bookmark.curator);

  $: curatorHref = (() => {
    try { return `/u/${nip19.npubEncode(bookmark.curator)}`; }
    catch { return `/u/${bookmark.curator}`; }
  })();

  function resolveLabel(displayName: string | undefined, pubkey: string): string {
    if (displayName) return displayName;
    try {
      const n = nip19.npubEncode(pubkey);
      return `${n.slice(0, 10)}…`;
    } catch {
      return pubkey.slice(0, 8);
    }
  }

  function prettyHost(url: string): string {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return url;
    }
  }

  function formatSats(n: number): string {
    return n.toLocaleString('en-US');
  }

  function showZapSuccess() {
    zapOpen = false;
    zapFlash = true;
    if (zapFlashTimer) clearTimeout(zapFlashTimer);
    zapFlashTimer = setTimeout(() => {
      zapFlash = false;
      zapFlashTimer = undefined;
    }, 1200);
  }

  onDestroy(() => {
    if (zapFlashTimer) clearTimeout(zapFlashTimer);
  });

  // Archive lookup: prefer the blossom tag baked into the bookmark
  // event (federates to other Nostr clients), fall back to the user's
  // own /account/archives index for bookmarks where the worker
  // archived after the kind:39701 was already published. The /account
  // path is owner-only by design — we won't surface the snapshot to
  // viewers who aren't the curator.
  $: ownArchive = isOwner ? $myArchives.get(bookmark.url) : undefined;
  $: archiveBlobHash = bookmark.blossomHash || ownArchive?.blobHash || null;
  $: archiveThumbHash = ownArchive?.thumbHash ?? null;
  // Private archives are AES-GCM ciphertext on Blossom — opening the
  // raw URL just downloads bytes the browser can't render. We detect
  // them via the owner-only /account/archives index (the kind:39701
  // event itself doesn't carry the tier so non-owners can't tell).
  $: isPrivateArchive = ownArchive?.tier === 'private';
  $: archiveHref = archiveBlobHash
    ? `${config.blossomUrl.replace(/\/$/, '')}/${archiveBlobHash}`
    : (bookmark.waybackUrl ?? null);
  $: showArchive = archiveHref !== null;
  $: archiveDownloadRecord = archiveRecordForDownload();

  // Private-archive decrypt-and-open flow (mirrors /app/archives openPrivate).
  // Inline so the user doesn't have to leave the bookmark list.
  let decryptingArchive = false;
  let decryptError = '';
  let downloadingArchive = false;
  let archiveDownloadError = '';

  function archiveRecordForDownload(): ArchiveRecord | null {
    if (ownArchive) return ownArchive;
    if (!bookmark.blossomHash) return null;
    return {
      jobId: bookmark.eventId,
      url: bookmark.url,
      blobHash: bookmark.blossomHash,
      tier: 'public',
      source: 'bookmark',
      archivedAt: bookmark.savedAt,
    };
  }

  async function downloadArchive(): Promise<void> {
    if (!archiveDownloadRecord) return;
    downloadingArchive = true;
    archiveDownloadError = '';
    try {
      await downloadArchiveRecord(archiveDownloadRecord, { pubkey: $session.pubkey });
    } catch (e) {
      archiveDownloadError = (e as Error).message ?? 'download failed';
    } finally {
      downloadingArchive = false;
    }
  }

  async function openPrivateArchive(): Promise<void> {
    if (!ownArchive || !$session.pubkey) return;
    decryptingArchive = true;
    decryptError = '';
    try {
      const map = await getArchiveKeyMap($session.pubkey);
      let key = map[ownArchive.blobHash];
      // Stash fallback: same idea as the download path. Keys for
      // recently-imported archives may live only in localStorage
      // until reconcileArchiveKeys promotes them to the relay-side
      // set; pull from the stash by jobId so the user can open it
      // right now.
      if (!key && ownArchive.jobId) {
        const stashed = getPendingArchiveKey(ownArchive.jobId);
        if (stashed) key = stashed;
      }
      if (!key) {
        throw new Error('no decryption key found — visit /app/archives once so we can publish your stashed keys.');
      }
      const res = await fetch(`${config.blossomUrl.replace(/\/$/, '')}/${ownArchive.blobHash}`);
      if (!res.ok) throw new Error(`blossom fetch ${res.status}`);
      const ciphertext = new Uint8Array(await res.arrayBuffer());
      const plaintext = await decryptArchiveBlob(ciphertext, key);
      const blob = new Blob([plaintext as BlobPart], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after the new tab has loaded — it keeps a strong ref
      // via document so revoke is safe once parsing is done.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      decryptError = (e as Error).message ?? 'failed to decrypt';
    } finally {
      decryptingArchive = false;
    }
  }

</script>

{#if !hidden}
<div class="bookmark" class:read-later={isReadLater}>
  <Favicon url={bookmark.url} size={16} />
  <div class="body">
    <div class="title">
      <a href={bookmark.url} target="_blank" rel="noreferrer">{bookmark.title}</a>
      {#if isOwner}
        <span class="privacy-chip" class:private={derivedIsPrivate} title={derivedIsPrivate ? 'only you can see this' : 'visible on the public feed'}>
          {derivedIsPrivate ? 'private' : 'public'}
        </span>
      {/if}
    </div>
    <div class="url">{prettyHost(bookmark.url)}</div>
    {#if bookmark.description}
      <div class="desc">{bookmark.description}</div>
    {/if}
    <!-- Row 1: facts (tags, who, when, privacy). Wraps cleanly on
         mobile because each item is its own flex child instead of a
         single long line of dot-separated text. "by username" is
         suppressed on your own bookmarks — you already know who
         saved it. -->
    <div class="meta meta-facts">
      {#if isReadLater}
        <span class="meta-pill readlater-pill" title="saved for later reading">📖 read later</span>
      {/if}
      {#if visibleTags.length}
        <span class="meta-group tags">
          {#each visibleTags as t}
            <a
              href={`/app/tags/${encodeURIComponent(t)}${isOwner ? '?scope=mine' : ''}`}
              class="tag"
            >{t}</a>
          {/each}
        </span>
      {/if}
      {#if !isOwner}
        <span class="meta-group">by <a href={curatorHref}>{resolvedLabel}</a></span>
      {/if}
      <span class="meta-time">{relativeTime(bookmark.savedAt)}</span>
      {#if saveCount !== undefined}
        <a class="meta-group meta-saves" href={`/app/url/${encodeURIComponent(bookmark.url)}`}>
          <span class="num-retro">{saveCount}</span> others saved this
        </a>
      {/if}
    </div>

    <!-- Row 2: actions (archive, zap, post-to-nostr, edit/follow,
         read-later toggle). Lives below the facts so it's visually
         separate and doesn't blur with metadata. -->
    <div class="meta meta-actions">
    {#if showArchive && !isNativeShell()}
<span class="archive-wrap">
        {#if isPrivateArchive}
          <!-- Private archive: ciphertext on Blossom. Click decrypts
               + opens in a blob: tab. The little lock dot on the icon
               distinguishes private from public — keeps the row's
               visual vocabulary down to one shape (archive box). -->
          <button
            type="button"
            class="archive-icon"
            on:click={() => void openPrivateArchive()}
            disabled={decryptingArchive}
            title={decryptingArchive ? 'decrypting archive' : 'open archive'}
            aria-label={decryptingArchive ? 'decrypting archive' : 'open archive'}
          >
            <Archive size={14} strokeWidth={2.2} />
          </button>
          <span class="archive-thumb-pop archive-thumb-pop--private" aria-hidden="true">
            <span class="thumb-placeholder">
              private archive<br />
              <small>encrypted — click to decrypt and open</small>
            </span>
          </span>
        {:else if archiveHref}
          <a
            class="archive-icon"
            href={archiveHref}
            target="_blank"
            rel="noreferrer"
            title="open archived snapshot (public)"
            aria-label="open archived snapshot (public)"
          >
            <Archive size={14} strokeWidth={2.2} />
          </a>
          {#if archiveThumbHash}
            <span class="archive-thumb-pop" aria-hidden="true">
              <img
                src={`${config.blossomUrl.replace(/\/$/, '')}/${archiveThumbHash}`}
                alt=""
                loading="lazy"
              />
            </span>
          {/if}
        {/if}
      </span>
      {#if isPrivateArchive && decryptError}
        <span class="archive-error">↳ {decryptError}</span>
      {/if}
      {#if archiveDownloadRecord}
        <button
          type="button"
          class="archive-download"
          on:click={() => void downloadArchive()}
          disabled={downloadingArchive}
          title="download the archived snapshot"
          aria-label="download archived snapshot"
        >
          <Download size={13} strokeWidth={2.2} />
        </button>
      {/if}
      {#if archiveDownloadError}
        <span class="archive-error">↳ {archiveDownloadError}</span>
      {/if}
    {/if}
    <button
      type="button"
      class="zap-btn zap"
      class:disabled={!$canSign}
      title={$canSign ? 'zap this bookmark' : 'connect a signer to zap'}
      on:click={() => $canSign && (zapOpen = true)}
      disabled={!$canSign}
    >
      ⚡ <span class="num-retro">{formatSats(zapSats)}</span> sats
    </button>
    {#if $session.pubkey}
<PostToNostrAction {bookmark} />
    {/if}
    {#if isOwner}
<button
        type="button"
        class="edit-action readlater-toggle"
        class:syncing={togglingReadLater}
        on:click={() => void onToggleReadLater()}
        disabled={togglingReadLater}
        title={isReadLater ? 'mark as read' : 'save for later reading'}
      >{isReadLater ? '✓ read' : '📖 read later'}</button>
<button
        type="button"
        class="edit-action"
        on:click={() => (editing = !editing)}
        title={editing ? 'close the editor' : 'edit bookmark'}
      >{editing ? '× close' : '✎ edit'}</button>
    {/if}
    <!-- Follow/unfollow lives on the curator's profile page only.
         Putting it on every row of every feed buried the actions row
         in chrome the user wasn't trying to act on. -->

    </div>

    {#if editing && isOwner}
      <BookmarkEditForm
        {bookmark}
        isPrivate={derivedIsPrivate}
        archiveRecord={ownArchive}
        on:cancel={() => (editing = false)}
        on:updated={() => (editing = false)}
        on:deleted={() => { hidden = true; editing = false; }}
      />
    {/if}
  </div>
</div>

{#if zapFlash}
  <div class="zap-flash" aria-live="polite">
    <span>⚡</span>
    <strong>zap sent</strong>
  </div>
{/if}

{/if}

<ZapDialog
  {bookmark}
  bind:open={zapOpen}
  on:close={() => (zapOpen = false)}
  on:paid={showZapSuccess}
/>

<style>
  .bookmark {
    padding: 14px 0;
    border-bottom: 1px solid var(--rule);
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .bookmark.read-later {
    background: var(--toread-tint);
    border-left: 3px solid var(--toread-accent);
    padding-left: 10px;
    margin-left: -13px;
    padding-right: 10px;
    margin-right: -10px;
  }
  .readlater-pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--toread-accent);
    color: #1a0f0c;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .bookmark :global(.favicon) {
    /* Lift the favicon to sit on the title's baseline-ish row. */
    margin-top: 2px;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 2px;
    letter-spacing: -0.1px;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }
  .title a:visited {
    color: var(--visited);
  }
  .privacy-chip {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    color: var(--ink);
    flex-shrink: 0;
  }
  .privacy-chip.private {
    background: rgba(255, 107, 90, 0.08);
    border-color: var(--coral-soft);
    color: var(--coral-deep);
  }
  .url {
    color: var(--muted);
    font-size: 10px;
    margin-bottom: 6px;
    font-family: 'Courier New', monospace;
  }
  .desc {
    margin: 5px 0 8px;
    color: var(--ink);
    font-size: 13px;
  }
  .meta {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
  }
  .meta a {
    color: var(--link);
  }
  .meta-facts {
    margin-top: 4px;
  }
  .meta-actions {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--rule);
    gap: 6px 12px;
  }
  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    line-height: 1.4;
    color: var(--ink);
  }
  .meta-time {
    color: var(--muted);
  }
  .meta-saves {
    color: var(--coral-deep);
    text-decoration: none;
  }
  .meta-saves:hover {
    text-decoration: underline;
  }
  .tags {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tag {
    display: inline-block;
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 1px 8px;
    margin-right: 3px;
    border-radius: 10px;
    font-size: 10px;
    color: var(--link) !important;
    transition: all 0.1s;
  }
  .tag:hover {
    background: var(--paper-warmer);
    border-color: var(--link);
    text-decoration: none;
  }
  .zap {
    color: var(--zap);
    font-weight: 600;
    cursor: pointer;
  }
  .zap:hover {
    color: #d97706;
  }
  .zap-btn {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 11px;
  }
  .zap-btn:disabled { cursor: not-allowed; }
  .zap-flash {
    position: fixed;
    left: 50%;
    top: 18%;
    z-index: 120;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-radius: 999px;
    background: var(--zap);
    color: #1a0f0c;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.22);
    animation: zapFlash 1.2s ease-out forwards;
    pointer-events: none;
  }
  .zap-flash span {
    font-size: 22px;
    line-height: 1;
  }
  .zap-flash strong {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  @keyframes zapFlash {
    0% { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.92); }
    12% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1.04); }
    24% { transform: translateX(-50%) translateY(0) scale(1); }
    78% { opacity: 1; }
    100% { opacity: 0; transform: translateX(-50%) translateY(-12px) scale(0.98); }
  }
  .zap.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .edit-action {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 11px;
    color: var(--link);
    cursor: pointer;
  }
  .edit-action:hover { color: var(--coral); }
  .edit-action:disabled { color: var(--muted); cursor: progress; }
  .readlater-toggle {
    color: var(--toread-accent);
    font-weight: 600;
  }
  .readlater-toggle:hover { color: var(--coral); }
  .readlater-toggle.syncing { opacity: 0.55; }
  .archive-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 19px;
    height: 19px;
    vertical-align: -4px;
    background: transparent;
    border: 1px solid var(--rule);
    border-radius: 5px;
    padding: 0;
    color: var(--archive);
    cursor: pointer;
    text-decoration: none;
  }
  .archive-icon:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral);
    text-decoration: none;
  }
  .archive-icon:disabled { cursor: progress; opacity: 0.7; }
  .archive-icon :global(svg) { display: block; }
  .archive-download {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 2px;
    padding: 0;
    vertical-align: -4px;
    background: transparent;
    border: 1px solid var(--rule);
    border-radius: 4px;
    color: var(--archive);
    cursor: pointer;
  }
  .archive-download:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral);
  }
  .archive-download:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .archive-download :global(svg) {
    display: block;
  }
  .archive-error {
    margin-left: 6px;
    color: #a33;
    font-size: 11px;
  }
  .archive-thumb-pop--private {
    width: 200px;
    text-align: center;
  }
  .archive-thumb-pop .thumb-placeholder {
    display: block;
    padding: 18px 12px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }
  .archive-thumb-pop .thumb-placeholder small {
    color: var(--muted);
    font-size: 10px;
  }
  /* Hover-thumbnail popover. Pure CSS — no JS event handlers, so it
     works the moment the row paints from cache. The img is lazy so
     scrolling past dozens of archived rows doesn't pre-fetch every
     thumbnail; first hover triggers the load. */
  .archive-wrap { position: relative; display: inline-block; }
  .archive-thumb-pop {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 50;
    display: none;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    pointer-events: none;
  }
  .archive-thumb-pop img {
    display: block;
    width: 280px;
    height: auto;
    max-height: 200px;
    object-fit: cover;
    border-radius: 4px;
  }
  .archive-wrap:hover .archive-thumb-pop,
  .archive-wrap:focus-within .archive-thumb-pop { display: block; }
</style>
