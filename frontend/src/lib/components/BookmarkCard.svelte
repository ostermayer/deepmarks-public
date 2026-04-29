<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { NDKEvent } from '@nostr-dev-kit/ndk';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { canSign, session } from '$lib/stores/session';
  import { getProfile } from '$lib/nostr/profiles';
  import { mutePubkey } from '$lib/nostr/mute-list';
  import { followedPubkeys, follow, unfollow } from '$lib/nostr/contacts';
  import { myArchives } from '$lib/stores/my-archives';
  import { getArchiveKeyMap, decryptArchiveBlob } from '$lib/nostr/archive-keys';
  import { relativeTime } from '$lib/util/time';
  import { config } from '$lib/config';
  import { getNdk } from '$lib/nostr/ndk';
  import { KIND } from '$lib/nostr/kinds';
  import Favicon from './Favicon.svelte';
  import ZapDialog from './ZapDialog.svelte';
  import BookmarkEditForm from './BookmarkEditForm.svelte';

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

  let zapOpen = false;
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
  $: showArchive = bookmark.archivedForever || archiveHref !== null;

  // Private-archive decrypt-and-open flow (mirrors /app/archives openPrivate).
  // Inline so the user doesn't have to leave the bookmark list.
  let decryptingArchive = false;
  let decryptError = '';
  async function openPrivateArchive(): Promise<void> {
    if (!ownArchive || !$session.pubkey) return;
    decryptingArchive = true;
    decryptError = '';
    try {
      const map = await getArchiveKeyMap($session.pubkey);
      const key = map[ownArchive.blobHash];
      if (!key) {
        throw new Error('no decryption key in your relay set — open it once from the deepmarks browser extension to seed the key.');
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

  // ── Share-as-post ────────────────────────────────────────────────
  // Two affordances: copy a NIP-19 nevent link (no signer needed),
  // and quote-post the bookmark as a kind:1 note (needs signer).
  // The dropdown opens on click; outside-click closes it.
  let shareOpen = false;
  let shareMessage = '';

  function shareNeventUrl(): string {
    try {
      // naddr is the right encoding for parameterized replaceable
      // events (kind:39701 is one of those). It carries kind + author
      // + d-identifier so any client can reconstruct the event.
      const naddr = nip19.naddrEncode({
        kind: KIND.webBookmark,
        pubkey: bookmark.curator,
        identifier: bookmark.url,
      });
      return `https://njump.me/${naddr}`;
    } catch {
      return '';
    }
  }

  async function copyShareLink() {
    const url = shareNeventUrl();
    if (!url) { shareMessage = 'failed to encode share link'; return; }
    try {
      await navigator.clipboard.writeText(url);
      shareMessage = 'share link copied';
    } catch {
      shareMessage = url;  // user can copy manually
    }
    setTimeout(() => { shareMessage = ''; shareOpen = false; }, 1500);
  }

  async function quotePost() {
    if (!$canSign) return;
    const ndk = getNdk();
    if (!ndk.signer) { shareMessage = 'no signer connected'; return; }
    try {
      const naddr = nip19.naddrEncode({
        kind: KIND.webBookmark,
        pubkey: bookmark.curator,
        identifier: bookmark.url,
      });
      const teaser = bookmark.title || bookmark.url;
      const ev = new NDKEvent(ndk, {
        kind: 1,
        pubkey: $session.pubkey ?? '',
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', `${KIND.webBookmark}:${bookmark.curator}:${bookmark.url}`],
          ['p', bookmark.curator],
          // NIP-89 client tag — same one we put on bookmarks.
          ['client', 'Deepmarks', '31990:7cb39c6fb61007613e90ffce2220887219d41601235ff08d09eae396a7d73800:deepmarks'],
        ],
        content: `${teaser}\n${bookmark.url}\nnostr:${naddr}`,
      });
      await ev.publish();
      shareMessage = 'posted';
      setTimeout(() => { shareMessage = ''; shareOpen = false; }, 1500);
    } catch (e) {
      shareMessage = (e as Error).message ?? 'post failed';
    }
  }
</script>

{#if !hidden}
<div class="bookmark">
  <Favicon url={bookmark.url} size={16} />
  <div class="body">
    <div class="title"><a href={bookmark.url} target="_blank" rel="noreferrer">{bookmark.title}</a></div>
    <div class="url">{prettyHost(bookmark.url)}</div>
    {#if bookmark.description}
      <div class="desc">{bookmark.description}</div>
    {/if}
    <div class="meta">
    {#if bookmark.tags.length}
      to <span class="tags">
        {#each bookmark.tags as t}
          <a href={`/app/tags/${encodeURIComponent(t)}`} class="tag">{t}</a>
        {/each}
      </span>
      <span class="meta-sep">·</span>
    {/if}
    by <a href={curatorHref}>{resolvedLabel}</a>
    <span class="meta-sep">·</span>
    {relativeTime(bookmark.savedAt)}
    {#if saveCount !== undefined}
      <span class="meta-sep">·</span>
      <a href={`/app/url/${encodeURIComponent(bookmark.url)}`}><span class="num-retro">{saveCount}</span> others saved this</a>
    {/if}
    {#if isOwner}
      <span class="meta-sep">·</span>
      <span class="privacy-tag" title={derivedIsPrivate ? 'only you can see this' : 'visible on the public feed'}>
        {#if derivedIsPrivate}🔒 private{:else}🌍 public{/if}
      </span>
    {/if}
    {#if showArchive}
      <span class="meta-sep">·</span>
      {#if isPrivateArchive}
        <!-- Private archive: ciphertext on Blossom; decrypt locally and open
             a blob: tab. No thumbnail by design — the screenshot pipeline
             skips private archives so the public-readable thumb can't leak
             page contents the encrypted blob otherwise hides. -->
        <span class="archive-wrap">
          <button
            type="button"
            class="archive-link archive-btn"
            on:click={() => void openPrivateArchive()}
            disabled={decryptingArchive}
            title="private archive — click to decrypt + open"
          >🔒 {decryptingArchive ? 'decrypting…' : 'archived'}</button>
          <span class="archive-thumb-pop archive-thumb-pop--private" aria-hidden="true">
            <span class="thumb-placeholder">
              🔒 private archive<br />
              <small>no thumbnail — click to decrypt</small>
            </span>
          </span>
        </span>
        {#if decryptError}
          <span class="archive-error">↳ {decryptError}</span>
        {/if}
      {:else if archiveHref}
        <span class="archive-wrap">
          <a class="archive-link" href={archiveHref} target="_blank" rel="noreferrer" title="open the archived snapshot">
            📦 archived
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
        </span>
      {:else}
        <span class="archive-link" title="archived forever — snapshot not yet linked on this event">📦 archived</span>
      {/if}
    {/if}
    <span class="meta-sep">·</span>
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
    <span class="meta-sep">·</span>
    <span class="share-wrap">
      <button
        type="button"
        class="share-action"
        on:click={() => (shareOpen = !shareOpen)}
        title="copy share link or quote-post as kind:1"
      >↗ share</button>
      {#if shareOpen}
        <div class="share-pop">
          <button type="button" class="share-item" on:click={() => void copyShareLink()}>copy share link</button>
          <button
            type="button"
            class="share-item"
            class:disabled={!$canSign}
            on:click={() => $canSign && void quotePost()}
            disabled={!$canSign}
            title={$canSign ? 'publish a kind:1 quote-post on Nostr' : 'connect a signer to quote-post'}
          >quote-post on Nostr</button>
          {#if shareMessage}<div class="share-msg">{shareMessage}</div>{/if}
        </div>
        <button type="button" class="share-backdrop" on:click={() => (shareOpen = false)} aria-label="close share menu" />
      {/if}
    </span>
    {#if isOwner}
      <span class="meta-sep">·</span>
      <button
        type="button"
        class="edit-action"
        on:click={() => (editing = !editing)}
        title={editing ? 'close the editor' : 'edit bookmark'}
      >{editing ? '× close' : '✎ edit'}</button>
    {:else if $session.pubkey}
      <span class="meta-sep">·</span>
      <button
        type="button"
        class="edit-action"
        on:click={async () => {
          if (!$session.pubkey) return;
          try {
            if ($followedPubkeys.has(bookmark.curator)) {
              await unfollow(bookmark.curator, $session.pubkey);
            } else {
              await follow(bookmark.curator, $session.pubkey);
            }
          } catch (e) {
            alert(`failed: ${(e as Error).message ?? 'unknown'}`);
          }
        }}
        title={$followedPubkeys.has(bookmark.curator) ? 'unfollow this curator' : "follow this curator's saves"}
      >{$followedPubkeys.has(bookmark.curator) ? '✓ following' : '+ follow'}</button>
      <span class="meta-sep">·</span>
      <button
        type="button"
        class="edit-action"
        on:click={async () => {
          if (!$session.pubkey) return;
          if (!confirm(`Mute ${resolvedLabel}? Their bookmarks will stop showing in your feeds. You can unmute from Settings.`)) return;
          try {
            await mutePubkey(bookmark.curator, $session.pubkey);
            hidden = true;
          } catch (e) {
            alert(`Failed to mute: ${(e as Error).message ?? 'unknown'}`);
          }
        }}
        title="mute this curator — they vanish from your feeds"
      >🔕 mute</button>
    {/if}
    </div>

    {#if editing && isOwner}
      <BookmarkEditForm
        {bookmark}
        isPrivate={derivedIsPrivate}
        on:cancel={() => (editing = false)}
        on:updated={() => (editing = false)}
        on:deleted={() => { hidden = true; editing = false; }}
      />
    {/if}
  </div>
</div>

{/if}

<ZapDialog {bookmark} bind:open={zapOpen} on:close={() => (zapOpen = false)} />

<style>
  .bookmark {
    padding: 14px 0;
    border-bottom: 1px solid var(--rule);
    display: flex;
    align-items: flex-start;
    gap: 10px;
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
  }
  .title a:visited {
    color: var(--visited);
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
  }
  .meta a {
    color: var(--link);
  }
  .tags {
    display: inline;
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
  .meta-sep {
    color: var(--rule);
    margin: 0 6px;
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
  .zap.disabled,
  .share-action.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .share-action {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .share-action:hover {
    color: var(--coral);
    text-decoration: none;
  }
  .share-wrap { position: relative; display: inline-block; }
  .share-pop {
    position: absolute;
    top: 22px;
    left: 0;
    z-index: 11;
    min-width: 180px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .share-pop .share-item {
    background: transparent;
    border: 0;
    text-align: left;
    padding: 6px 12px;
    color: var(--ink-deep);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    border-radius: 4px;
  }
  .share-pop .share-item:hover { background: var(--paper-warm); }
  .share-pop .share-item.disabled { opacity: 0.5; cursor: not-allowed; }
  .share-msg { padding: 6px 12px; color: var(--muted); font-size: 11px; }
  .share-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    z-index: 10;
    cursor: default;
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
  .privacy-tag {
    color: var(--ink);
    font-size: 11px;
    font-weight: 500;
  }
  .archive-link {
    color: var(--archive);
    font-weight: 500;
    text-decoration: none;
  }
  .archive-link:hover {
    color: var(--coral);
    text-decoration: underline;
  }
  .archive-btn {
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .archive-btn:disabled { cursor: progress; opacity: 0.7; }
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
