<script lang="ts">
  import { onDestroy } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { Archive, Download, File, FileText, Play } from 'lucide-svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import type { ArchiveRecord } from '$lib/api/client';
  import { canSign, session } from '$lib/stores/session';
  import { getProfile } from '$lib/nostr/profiles';
  import { myArchives, myArchivesByVideoKey } from '$lib/stores/my-archives';
  import {
    archiveBlobUrl,
    archiveFileAsRecord,
    archiveFileLabel,
    archiveFiles,
    archiveMime,
    isArchiveMedia,
    closeReservedArchiveWindow,
    downloadArchiveRecord,
    fetchArchiveBytes,
    openArchiveBlobUrl,
    reserveArchiveOpenWindow,
    type ArchiveFile,
  } from '$lib/archives/download';
  import { relativeTime } from '$lib/util/time';
  import { isNativeShell } from '$lib/native/runtime';
  import Favicon from './Favicon.svelte';
  import Avatar from './Avatar.svelte';
  import ZapDialog from './ZapDialog.svelte';
  import BookmarkEditForm from './BookmarkEditForm.svelte';
  import NostrText from './NostrText.svelte';
  import PostToNostrAction from './PostToNostrAction.svelte';
  import SocialLinkPreview from './SocialLinkPreview.svelte';
  import { toggleReadLater } from '$lib/nostr/toggle-read-later';
  import { mySavedUrls } from '$lib/stores/my-saved-urls';
  import { describeLinkPreview, isLikelyBlossomBlobUrl, parseYoutubeVideoId, readableHost } from '$lib/metadata/link-preview';
  import { nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import { readableNostrText } from '$lib/nostr/text-refs';
  import type { ZapInvoice } from '$lib/nostr/zap';

  export let bookmark: ParsedBookmark;
  /** Caller-supplied override (rare — most callers let us resolve from
   *  the kind:0 profile). Falls through to displayName → short npub → hex. */
  export let curatorName: string = '';
  export let saveCount: number | undefined = undefined;
  export let zapSats: number = 0;
  /** Compact rows are used on profile pages where the profile header
   *  already supplies context and the list needs to scan more densely. */
  export let compact: boolean = false;
  /** Profile pages should send tag clicks to the public network tag
   *  view even when the signed-in viewer owns the bookmark. */
  export let tagScope: 'auto' | 'network' | 'mine' = 'auto';
  /** Hide the curator byline when the surrounding page is already a
   *  specific user's profile. */
  export let showCurator: boolean = true;
  /** Friends' feed can show richer page/video previews for normal links. */
  export let richPreview: boolean = false;
  /** Show the curator profile icon next to the byline. */
  export let showAuthorAvatar: boolean = true;
  /** True when the row came from the user's encrypted NIP-51 private set
   *  rather than a kind:39701. Drives the 🔒/🌍 indicator on owner rows.
   *  Auto-derived from the bookmark's eventId prefix when not passed
   *  explicitly: parsePrivateEntry stamps eventId with `private:<url>`
   *  for NIP-51 entries, kind:39701 events keep their hex id. Letting
   *  the card self-classify means callers don't have to plumb the
   *  flag through every list — important because BookmarkList didn't,
   *  and /app was rendering every row as 'public' regardless of source. */
  export let isPrivate: boolean | undefined = undefined;

  type BookmarkSource = ParsedBookmark & {
    source?: string;
    sourceEventId?: string;
    sourceContent?: string;
    sourceMediaThumbnail?: string;
    sourceMediaMime?: string;
  };

  $: derivedIsPrivate = isPrivate ?? bookmark.eventId.startsWith('private:');
  $: isOwner = $session.pubkey === bookmark.curator;
  $: sourceBookmark = bookmark as BookmarkSource;
  $: isNostrNoteLink = sourceBookmark.source === 'nostr-note-link';
  $: sourceNoteUrl = isNostrNoteLink && sourceBookmark.sourceEventId
    ? nostrNoteArchiveUrl(sourceBookmark.sourceEventId)
    : null;
  $: saveTargetUrl = sourceNoteUrl ?? bookmark.url;
  $: sourceNoteText = sourceBookmark.sourceContent?.trim() ?? '';
  $: sourceMediaThumbnail = sourceBookmark.sourceMediaThumbnail ?? '';
  $: sourceMediaKind = mediaKindFromMime(sourceBookmark.sourceMediaMime);
  $: linkPreview = describeLinkPreview(bookmark.url);
  $: isDirectMediaPreview = linkPreview?.kind === 'image' || linkPreview?.kind === 'video' || linkPreview?.kind === 'audio';
  $: isBlossomBlobPreview = isLikelyBlossomBlobUrl(bookmark.url);
  $: showLinkPreview = richPreview || isNostrNoteLink || isDirectMediaPreview || isBlossomBlobPreview;
  $: showPreviewText = !(isNostrNoteLink && (isDirectMediaPreview || isBlossomBlobPreview || !!sourceMediaKind));
  $: savedByMe = isOwner || $mySavedUrls.has(saveTargetUrl);
  $: showSaveLink = !!$session.pubkey && !savedByMe;
  $: isReadLater = bookmark.tags.includes('toread');
  $: visibleTags = bookmark.tags.filter((t) => t !== 'toread');
  $: resolvedTagScope = tagScope === 'auto'
    ? (isOwner ? 'mine' : 'network')
    : tagScope;
  const nativeShell = isNativeShell();

  let togglingReadLater = false;
  let previewTitle = '';
  let previewDescription = '';
  $: displayTitle = readableNostrText(previewTitle || bookmark.title);
  $: displayDescription = previewDescription || bookmark.description;
  $: displayUrl = isNostrNoteLink ? socialLinkHost(bookmark.url) : prettyHost(bookmark.url);

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
        alert(`couldn't update: ${(e as Error).message ?? 'unknown'}`);
      })
      .finally(() => {
        togglingReadLater = false;
      });
  }

  let zapOpen = false;
  let zapFlash = false;
  let zapFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let optimisticZapSats = 0;
  let editing = false;
  let hidden = false;

  // Resolve the curator's kind:0 profile once and react when it lands.
  // Without this the by-line shows a truncated hex, which is what users
  // saw on /app/recent + /app/network.
  $: profile = getProfile(bookmark.curator);
  $: resolvedLabel = curatorName || resolveLabel($profile?.displayName, bookmark.curator);
  $: if (zapSats > optimisticZapSats) optimisticZapSats = zapSats;
  $: displayedZapSats = Math.max(zapSats, optimisticZapSats);

  $: curatorHref = (() => {
    try { return `/u/${nip19.npubEncode(bookmark.curator)}`; }
    catch { return `/u/${bookmark.curator}`; }
  })();

  function tagHref(tag: string): string {
    const encoded = encodeURIComponent(tag);
    return resolvedTagScope === 'mine'
      ? `/app/tags/${encoded}`
      : `/app/explore?tag=${encoded}`;
  }

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

  function hostOnly(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function socialLinkHost(url: string): string {
    try {
      return readableHost(new URL(url));
    } catch {
      return hostOnly(url);
    }
  }

  function onPreviewMetadata(event: CustomEvent<{ title?: string; description?: string; image?: string }>): void {
    const { title, description } = event.detail;
    if (title) previewTitle = title;
    if (description) previewDescription = description;
  }

  function saveHref(): string {
    const params = new URLSearchParams({ url: saveTargetUrl });
    const targetTitle = isNostrNoteLink
      ? noteSaveTitle()
      : displayTitle;
    const targetDescription = isNostrNoteLink
      ? sourceNoteText || displayDescription
      : displayDescription;
    if (targetTitle && targetTitle !== saveTargetUrl) params.set('title', targetTitle);
    if (targetDescription) params.set('description', targetDescription);
    if (visibleTags.length > 0) params.set('tags', visibleTags.join(','));
    return `/app/save?${params.toString()}`;
  }

  function noteSaveTitle(): string {
    if (sourceNoteText) return sourceNoteText.slice(0, 96);
    return `Nostr post by ${resolvedLabel}`;
  }

  function mediaKindFromMime(mime: string | undefined): 'image' | 'video' | 'audio' | '' {
    if (!mime) return '';
    const normalized = mime.toLowerCase();
    if (normalized.startsWith('image/')) return 'image';
    if (normalized.startsWith('video/')) return 'video';
    if (normalized.startsWith('audio/')) return 'audio';
    return '';
  }

  function formatSats(n: number): string {
    return n.toLocaleString('en-US');
  }

  function showZapSuccess(event: CustomEvent<{ preimages: string[]; invoices: ZapInvoice[] }>) {
    const paidSats = event.detail.invoices.reduce(
      (sum, invoice) => sum + Math.floor(invoice.recipient.millisats / 1000),
      0,
    );
    if (paidSats > 0) optimisticZapSats = Math.max(optimisticZapSats, zapSats) + paidSats;
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
  $: ownArchive = resolveOwnArchive(isOwner, bookmark.url, $myArchives, $myArchivesByVideoKey);
  $: archiveBlobHash = bookmark.blossomHash || ownArchive?.blobHash || null;
  $: archiveThumbHash = ownArchive?.thumbHash ?? null;
  let loadedArchiveThumbHash = '';
  let failedArchiveThumbHash = '';
  $: archiveThumbVisible = !!archiveThumbHash && archiveThumbHash !== failedArchiveThumbHash && !nativeShell;
  $: archiveThumbReady = archiveThumbVisible && archiveThumbHash === loadedArchiveThumbHash;
  $: archiveThumbUrl = archiveThumbHash ? archiveBlobUrl(archiveThumbHash) : '';
  // Private archives are AES-GCM ciphertext on Blossom — opening the
  // raw URL just downloads bytes the browser can't render. We detect
  // them via the owner-only /account/archives index (the kind:39701
  // event itself doesn't carry the tier so non-owners can't tell).
  $: isPrivateArchive = ownArchive?.tier === 'private';
  $: archiveHref = archiveBlobHash
    ? archiveBlobUrl(archiveBlobHash)
    : (bookmark.waybackUrl ?? null);
  $: showArchive = archiveHref !== null;
  $: archiveDownloadRecord = archiveRecordForDownload();
  $: archiveChoices = ownArchive ? archiveFiles(ownArchive) : (archiveDownloadRecord ? archiveFiles(archiveDownloadRecord) : []);
  $: hasArchiveChoices = archiveChoices.length > 1;
  // Media archives (the paid yt-dlp add-on) are the buyer's private video/
  // audio/image. They get a dedicated inline player instead of the file
  // chooser so the buyer is presented with the video — not dumped onto a raw
  // encrypted Blossom blob that renders as a blank page.
  $: ownArchiveIsMedia = !!ownArchive && (
    isArchiveMedia(ownArchive)
    || !!ownArchive.videoContentKey
    || !!ownArchive.videoId
    || (ownArchive.files ?? []).some((file) => file.role === 'media')
  );
  $: mediaArchiveRecord = ownArchive && ownArchiveIsMedia ? mediaFileRecordFor(ownArchive) : null;

  // Private-archive decrypt-and-open flow.
  // Inline so the user doesn't have to leave the bookmark list.
  let archiveChooserOpen = false;
  let decryptingArchive = false;
  let decryptError = '';
  let downloadingArchive = false;
  let archiveDownloadError = '';

  // Inline media player for the paid media archive. The encrypted bytes are
  // decrypted client-side with the buyer's archive key and played in place;
  // the ciphertext never leaves our store unencrypted.
  let mediaPlayerOpen = false;
  let mediaPlayerLoading = false;
  let mediaPlayerError = '';
  let mediaPlayerUrl = '';
  let mediaPlayerKind: 'video' | 'audio' | 'image' | 'other' = 'other';

  // Resolve the signed-in owner's archive for this row. Exact-URL match
  // first; then fall back to the media `videoContentKey` index, because
  // media add-on archives are stored under the canonicalized URL (e.g.
  // YouTube normalized to the 11-char id) and won't equal the original
  // bookmark URL string. Without this fallback the row never finds its
  // own private media archive and renders the public Blossom link.
  function resolveOwnArchive(
    owner: boolean,
    url: string,
    byUrl: Map<string, ArchiveRecord>,
    byVideoKey: Map<string, ArchiveRecord>,
  ): ArchiveRecord | undefined {
    if (!owner) return undefined;
    const exact = byUrl.get(url);
    const key = bookmarkVideoContentKey(url);
    const media = key ? byVideoKey.get(key) : undefined;
    if (media && (!exact || (recordIsMedia(media) && !recordIsMedia(exact)))) return media;
    return exact ?? media;
  }

  function bookmarkVideoContentKey(url: string): string | null {
    try {
      const id = parseYoutubeVideoId(new URL(url));
      return id ? `yt:${id.toLowerCase()}` : null;
    } catch {
      return null;
    }
  }

  function mediaFileRecordFor(rec: ArchiveRecord): ArchiveRecord {
    const files = archiveFiles(rec);
    const media = files.find((file) => file.role === 'media')
      ?? files.find((file) => {
        const ct = file.contentType ?? '';
        return ct.startsWith('video/') || ct.startsWith('audio/') || ct.startsWith('image/');
      });
    return media ? archiveFileAsRecord(rec, media) : rec;
  }

  function recordIsMedia(rec: ArchiveRecord): boolean {
    return isArchiveMedia(rec) ||
      !!rec.videoContentKey ||
      !!rec.videoId ||
      (rec.files ?? []).some((file) => file.role === 'media');
  }

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

  async function openPrivateArchive(record = ownArchive): Promise<void> {
    if (!record || !$session.pubkey) return;
    const reservedWindow = reserveArchiveOpenWindow(record);
    decryptingArchive = true;
    decryptError = '';
    try {
      const plaintext = await fetchArchiveBytes(record, { pubkey: $session.pubkey });
      const blob = new Blob([plaintext as BlobPart], {
        type: archiveMime(record),
      });
      const url = URL.createObjectURL(blob);
      if (!openArchiveBlobUrl(url, record, reservedWindow)) {
        URL.revokeObjectURL(url);
        throw new Error('archive decrypted, but this browser blocked opening it. Use download instead.');
      }
      // Revoke after the new tab has loaded — it keeps a strong ref
      // via document so revoke is safe once parsing is done.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      closeReservedArchiveWindow(reservedWindow);
      decryptError = (e as Error).message ?? 'failed to decrypt';
    } finally {
      decryptingArchive = false;
    }
  }

  async function watchMediaArchive(): Promise<void> {
    const record = mediaArchiveRecord;
    if (!record) return;
    if (mediaPlayerOpen) {
      closeMediaPlayer();
      archiveChooserOpen = false;
      return;
    }
    mediaPlayerOpen = true;
    mediaPlayerError = '';
    if (mediaPlayerUrl) {
      archiveChooserOpen = false;
      return; // already decrypted earlier this session
    }
    mediaPlayerLoading = true;
    try {
      const bytes = await fetchArchiveBytes(record, { pubkey: $session.pubkey });
      const mime = archiveMime(record);
      // Matroska is the worker's fallback container — browsers can't decode it
      // inline, so steer those buyers to the download instead of a dead player.
      mediaPlayerKind = mime.startsWith('video/') && mime !== 'video/x-matroska'
        ? 'video'
        : mime.startsWith('audio/') && mime !== 'audio/x-matroska'
          ? 'audio'
          : mime.startsWith('image/')
            ? 'image'
            : 'other';
      const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      archiveChooserOpen = false;
      if (nativeShell) {
        if (!openArchiveBlobUrl(objectUrl, record, null, { preferSameTab: true })) {
          URL.revokeObjectURL(objectUrl);
          throw new Error('archive decrypted, but this device blocked opening it. Use download instead.');
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
        mediaPlayerOpen = false;
        return;
      }
      mediaPlayerUrl = objectUrl;
    } catch (e) {
      mediaPlayerError = (e as Error).message ?? 'failed to decrypt';
      mediaPlayerOpen = false;
    } finally {
      mediaPlayerLoading = false;
    }
  }

  function closeMediaPlayer(): void {
    mediaPlayerOpen = false;
    if (mediaPlayerUrl) {
      URL.revokeObjectURL(mediaPlayerUrl);
      mediaPlayerUrl = '';
    }
    mediaPlayerKind = 'other';
  }

  onDestroy(() => {
    if (mediaPlayerUrl) URL.revokeObjectURL(mediaPlayerUrl);
  });

  function openArchiveChoice(file: ArchiveFile): void {
    archiveChooserOpen = false;
    if (!ownArchive && !archiveDownloadRecord) return;
    const record = archiveFileAsRecord(ownArchive ?? archiveDownloadRecord!, file);
    if (record.tier === 'private') {
      void openPrivateArchive(record);
      return;
    }
    openArchiveBlobUrl(archiveBlobUrl(file.blobHash), record);
  }

</script>

{#if !hidden}
<div
  class="bookmark"
  class:read-later={isReadLater}
  class:compact
>
  <Favicon url={bookmark.url} size={16} />
  <div class="body">
    <div class="title">
      <a href={bookmark.url} target="_blank" rel="noreferrer">{displayTitle}</a>
      {#if isOwner}
        <span class="privacy-chip" class:private={derivedIsPrivate} title={derivedIsPrivate ? 'only you can see this' : 'visible on the public feed'}>
          {derivedIsPrivate ? 'private' : 'public'}
        </span>
      {/if}
    </div>
    <div class="url">{displayUrl}</div>
    {#if displayDescription && !showLinkPreview}
      <div class="desc"><NostrText text={displayDescription} /></div>
    {/if}
    {#if showLinkPreview}
      <SocialLinkPreview
        url={bookmark.url}
        title={displayTitle}
        description={displayDescription}
        fetchMetadata={richPreview || isNostrNoteLink || isBlossomBlobPreview}
        showText={showPreviewText}
        thumbnailUrl={sourceMediaThumbnail}
        mediaKindHint={sourceMediaKind}
        on:metadata={onPreviewMetadata}
      />
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
              href={tagHref(t)}
              class="tag"
            >{t}</a>
          {/each}
        </span>
      {/if}
      {#if showCurator && !isOwner}
        <span class="meta-group curator-chip">
          {#if showAuthorAvatar}
            <a class="curator-avatar" href={curatorHref} aria-label={resolvedLabel}>
              <Avatar pubkey={bookmark.curator} size={18} label={resolvedLabel} />
            </a>
          {/if}
          <span>by <a href={curatorHref}>{resolvedLabel}</a></span>
        </span>
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
      {#if showArchive}
        <span class="archive-wrap">
          {#if ownArchiveIsMedia}
            <button
              type="button"
              class="archive-icon"
              class:archive-icon--private={isPrivateArchive}
              class:active={archiveChooserOpen || mediaPlayerOpen}
              on:click={() => (archiveChooserOpen = !archiveChooserOpen)}
              disabled={mediaPlayerLoading}
              title={mediaPlayerLoading ? 'decrypting video' : 'archive actions'}
              aria-label={mediaPlayerLoading ? 'decrypting archived video' : 'archive actions'}
              aria-expanded={archiveChooserOpen}
            >
              <Archive size={14} strokeWidth={2.2} />
            </button>
            {#if archiveChooserOpen}
              <span class="archive-choice-pop" role="menu" aria-label="archive actions">
                <button
                  type="button"
                  class="archive-choice-item"
                  role="menuitem"
                  on:click={() => void watchMediaArchive()}
                >
                  <Play size={16} strokeWidth={2.2} />
                  <span>{mediaPlayerOpen ? 'hide' : 'play'}</span>
                </button>
                <button
                  type="button"
                  class="archive-choice-item"
                  role="menuitem"
                  on:click={() => {
                    archiveChooserOpen = false;
                    void downloadArchive();
                  }}
                  disabled={downloadingArchive}
                >
                  <Download size={16} strokeWidth={2.1} />
                  <span>download</span>
                </button>
              </span>
            {/if}
          {:else if hasArchiveChoices}
            <button
              type="button"
              class="archive-icon"
              class:archive-icon--private={isPrivateArchive}
              class:active={archiveChooserOpen}
              on:click={() => (archiveChooserOpen = !archiveChooserOpen)}
              disabled={decryptingArchive}
              title="choose archive file"
              aria-label="choose archive file"
              aria-expanded={archiveChooserOpen}
            >
              <Archive size={14} strokeWidth={2.2} />
            </button>
            {#if archiveChooserOpen}
              <span class="archive-choice-pop" role="menu" aria-label="archive files">
                {#each archiveChoices as file}
                  {#if isPrivateArchive}
                    <button
                      type="button"
                      class="archive-choice-item"
                      role="menuitem"
                      on:click={() => openArchiveChoice(file)}
                    >
                      {#if file.role === 'pdf'}
                        <FileText size={16} strokeWidth={2.1} />
                      {:else if file.role === 'html'}
                        <Archive size={16} strokeWidth={2.1} />
                      {:else}
                        <File size={16} strokeWidth={2.1} />
                      {/if}
                      <span>{archiveFileLabel(file)}</span>
                    </button>
                  {:else}
                    <a
                      class="archive-choice-item"
                      role="menuitem"
                      href={archiveBlobUrl(file.blobHash)}
                      target="_blank"
                      rel="noreferrer"
                      on:click={() => (archiveChooserOpen = false)}
                    >
                      {#if file.role === 'pdf'}
                        <FileText size={16} strokeWidth={2.1} />
                      {:else if file.role === 'html'}
                        <Archive size={16} strokeWidth={2.1} />
                      {:else}
                        <File size={16} strokeWidth={2.1} />
                      {/if}
                      <span>{archiveFileLabel(file)}</span>
                    </a>
                  {/if}
                {/each}
              </span>
            {/if}
          {:else if isPrivateArchive}
            <button
              type="button"
              class="archive-icon"
              class:archive-icon--private={isPrivateArchive}
              on:click={() => void openPrivateArchive()}
              disabled={decryptingArchive}
              title={decryptingArchive ? 'decrypting archive' : 'open archive'}
              aria-label={decryptingArchive ? 'decrypting archive' : 'open archive'}
            >
              <Archive size={14} strokeWidth={2.2} />
            </button>
            {#if !nativeShell}
              <span class="archive-thumb-pop archive-thumb-pop--private archive-thumb-pop--ready" aria-hidden="true">
                <span class="thumb-placeholder">
                  private archive<br />
                  <small>encrypted — click to decrypt and open</small>
                </span>
              </span>
            {/if}
          {:else if archiveHref}
            <a
              class="archive-icon"
              class:archive-icon--private={isPrivateArchive}
              href={archiveHref}
              target="_blank"
              rel="noreferrer"
              title="open archived snapshot (public)"
              aria-label="open archived snapshot (public)"
            >
              <Archive size={14} strokeWidth={2.2} />
            </a>
            {#if archiveThumbVisible}
              <span class="archive-thumb-pop" class:archive-thumb-pop--ready={archiveThumbReady} aria-hidden="true">
                <img
                  src={archiveThumbUrl}
                  alt=""
                  loading="lazy"
                  on:load={() => {
                    if (archiveThumbHash) loadedArchiveThumbHash = archiveThumbHash;
                  }}
                  on:error={() => {
                    if (archiveThumbHash) failedArchiveThumbHash = archiveThumbHash;
                  }}
                />
              </span>
            {/if}
          {/if}
        </span>
        {#if archiveDownloadRecord && !nativeShell}
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
      {/if}
      {#if showSaveLink}
        <a
          class="save-link"
          href={saveHref()}
          title={isNostrNoteLink ? 'save this Nostr post to your posts' : 'save this link to your bookmarks'}
        >＋ {isNostrNoteLink ? 'save post' : 'save'}</a>
      {/if}
      <button
        type="button"
        class="zap-btn zap"
        class:disabled={!$canSign}
        title={$canSign ? 'zap this link' : 'connect a signer to zap'}
        on:click={() => $canSign && (zapOpen = true)}
        disabled={!$canSign}
      >
        ⚡ <span class="num-retro">{formatSats(displayedZapSats)}</span> sats
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

    {#if (isPrivateArchive && decryptError) || archiveDownloadError}
      <div class="archive-error-row" aria-live="polite">
        {#if isPrivateArchive && decryptError}
          <span>↳ {decryptError}</span>
        {/if}
        {#if archiveDownloadError}
          <span>↳ {archiveDownloadError}</span>
        {/if}
      </div>
    {/if}

    {#if ownArchiveIsMedia && mediaPlayerOpen}
      <div class="archive-media">
        {#if mediaPlayerLoading}
          <div class="archive-media-status">decrypting your archived video…</div>
        {:else if mediaPlayerError}
          <div class="archive-media-status archive-media-status--error">↳ {mediaPlayerError}</div>
        {:else if mediaPlayerKind === 'video'}
          <!-- svelte-ignore a11y_media_has_caption: the buyer's own private archive; no separate caption track to attach. -->
          <video class="archive-media-el" src={mediaPlayerUrl} controls autoplay playsinline preload="metadata"></video>
        {:else if mediaPlayerKind === 'audio'}
          <audio class="archive-media-el archive-media-el--audio" src={mediaPlayerUrl} controls autoplay preload="metadata"></audio>
        {:else if mediaPlayerKind === 'image'}
          <img class="archive-media-el" src={mediaPlayerUrl} alt={displayTitle} />
        {:else}
          <div class="archive-media-status">
            this file can’t play in the browser — download it to watch on your device.
          </div>
        {/if}
        {#if !mediaPlayerLoading && !mediaPlayerError}
          <div class="archive-media-actions">
            <button
              type="button"
              class="archive-media-link"
              on:click={() => void downloadArchive()}
              disabled={downloadingArchive}
            >⬇ {downloadingArchive ? 'downloading…' : 'download'}</button>
            <button type="button" class="archive-media-link" on:click={closeMediaPlayer}>× close</button>
          </div>
        {/if}
      </div>
    {/if}

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
    border-bottom: 1px solid color-mix(in srgb, var(--ink) 22%, var(--rule));
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .bookmark.compact {
    padding: 9px 0;
    gap: 8px;
  }
  .bookmark.read-later {
    background: var(--toread-tint);
    border-left: 3px solid var(--toread-accent);
    padding-left: 10px;
    margin-left: -13px;
    padding-right: 10px;
    margin-right: -10px;
  }
  .bookmark.compact.read-later {
    padding-left: 8px;
    margin-left: -11px;
    padding-right: 8px;
    margin-right: -8px;
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
    min-width: 0;
  }
  .compact .title {
    font-size: 13px;
    margin-bottom: 1px;
    gap: 6px;
  }
  .title a:visited {
    color: var(--visited);
  }
  .title a {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
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
  .compact .privacy-chip {
    font-size: 9px;
    padding: 0 7px;
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
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .compact .url {
    margin-bottom: 3px;
  }
  .desc {
    margin: 5px 0 8px;
    color: var(--ink);
    font-size: 13px;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .compact .desc {
    margin: 3px 0 5px;
    font-size: 12px;
    line-height: 1.35;
  }
  .meta {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
  }
  .compact .meta {
    font-size: 10.5px;
    gap: 3px 8px;
  }
  .meta a {
    color: var(--link);
  }
  .meta-group {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .curator-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .curator-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    text-decoration: none;
    flex-shrink: 0;
  }
  .curator-avatar:hover {
    text-decoration: none;
  }
  .meta-facts {
    margin-top: 4px;
  }
  .compact .meta-facts {
    margin-top: 2px;
  }
  .meta-actions {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--rule);
    gap: 6px 12px;
  }
  .compact .meta-actions {
    margin-top: 4px;
    padding-top: 4px;
    gap: 4px 10px;
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
  .compact .tag {
    padding: 0 7px;
    font-size: 10px;
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
  .save-link {
    color: var(--coral-deep);
    font-weight: 600;
    text-decoration: none;
  }
  .save-link:hover {
    color: var(--coral);
    text-decoration: underline;
  }
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
  .archive-icon.active {
    border-color: var(--archive);
    background: color-mix(in srgb, var(--archive) 12%, transparent);
  }
  .archive-icon--private {
    border-color: var(--coral-soft);
    color: var(--coral-deep);
    background: rgba(255, 107, 90, 0.04);
  }
  .archive-icon--private.active {
    border-color: var(--coral-deep);
    background: color-mix(in srgb, var(--coral) 12%, transparent);
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
  .archive-error-row {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: #a33;
    font-size: 11px;
    line-height: 1.35;
  }
  .archive-media {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .archive-media-el {
    display: block;
    width: 100%;
    max-width: 560px;
    max-height: 360px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: #000;
  }
  .archive-media-el--audio {
    max-height: none;
    background: transparent;
  }
  .archive-media-status {
    font-size: 12px;
    color: var(--muted, #777);
    padding: 6px 0;
  }
  .archive-media-status--error {
    color: #a33;
  }
  .archive-media-actions {
    display: flex;
    gap: 10px;
  }
  .archive-media-link {
    background: transparent;
    border: 1px solid var(--rule);
    border-radius: 5px;
    padding: 3px 9px;
    font-size: 12px;
    color: var(--archive);
    cursor: pointer;
  }
  .archive-media-link:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral);
  }
  .archive-media-link:disabled {
    opacity: 0.6;
    cursor: progress;
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
  .archive-choice-pop {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 70;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 7px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  }
  .archive-choice-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 54px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--rule);
    border-radius: 5px;
    background: var(--paper-warm);
    color: var(--archive);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }
  .archive-choice-item:hover {
    border-color: var(--coral);
    color: var(--coral);
    text-decoration: none;
  }
  .archive-choice-item:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .archive-choice-item :global(svg) {
    flex: 0 0 auto;
  }
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
  .archive-wrap:hover .archive-thumb-pop--ready,
  .archive-wrap:focus-within .archive-thumb-pop--ready { display: block; }

  @media (hover: none), (max-width: 700px) {
    .archive-download {
      display: none;
    }
    .archive-thumb-pop,
    .archive-wrap:hover .archive-thumb-pop--ready,
    .archive-wrap:focus-within .archive-thumb-pop--ready {
      display: none;
    }
  }
</style>
