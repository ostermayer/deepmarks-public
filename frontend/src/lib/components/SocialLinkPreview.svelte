<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { loadUrlPreview } from '$lib/metadata/url-preview-cache';
  import { describeLinkPreview, youtubeEmbedUrl, type LinkPreviewKind } from '$lib/metadata/link-preview';
  import { safeExternalHref } from '$lib/nostr/bookmarks';

  export let url = '';
  export let title = '';
  export let description = '';
  /** Direct media previews are intentionally no-scrape; only friends'
   *  social-note links opt into metadata fetches when near the viewport. */
  export let fetchMetadata = true;
  /** Media-only friends-feed rows should render the image/video without
   *  adding caption-like preview copy below it. */
  export let showText = true;
  /** Optional NIP-92/imeta poster supplied by the source Nostr note. */
  export let thumbnailUrl = '';
  /** Optional NIP-92/imeta media kind supplied by the source Nostr note. */
  export let mediaKindHint: LinkPreviewKind | '' = '';

  const dispatch = createEventDispatcher<{
    metadata: { title?: string; description?: string; image?: string };
  }>();
  const PREFETCH_ROOT_MARGIN = '1800px 0px 1400px';
  const RENDER_ROOT_MARGIN = '700px 0px 700px';
  const DEFAULT_VIDEO_THUMB_TIME = 3.5;

  let mounted = false;
  let previewRequestedFor = '';
  let previewTitle = '';
  let previewDescription = '';
  let previewImage = '';
  let previewMediaKind: LinkPreviewKind | '' = '';
  let mediaActive = false;
  let previewWarmed = false;
  let previewVisible = false;
  let previewElement: HTMLDivElement | undefined;
  let prefetchObserver: IntersectionObserver | undefined;
  let renderObserver: IntersectionObserver | undefined;

  $: linkPreview = describeLinkPreview(url);
  $: displayTitle = previewTitle || title;
  $: displayDescription = previewDescription || description;
  $: effectiveKind = previewMediaKind || mediaKindHint || linkPreview?.kind || '';
  $: previewImageUrl = previewImage || thumbnailUrl || linkPreview?.thumbnailUrl || (effectiveKind === 'image' ? url : '');
  $: canInlinePlay = effectiveKind === 'youtube' || effectiveKind === 'video' || effectiveKind === 'audio';
  $: showRichPreview = previewVisible && !!linkPreview && (
    !!previewImageUrl ||
    canInlinePlay ||
    (showText && !!displayDescription)
  );
  $: youtubeEmbedSrc = linkPreview?.youtubeId ? youtubeEmbedUrl(linkPreview.youtubeId) : '';
  $: videoThumbnailSrc = effectiveKind === 'video' ? mediaFragmentUrl(url, DEFAULT_VIDEO_THUMB_TIME) : '';

  $: if (mounted && previewWarmed && url && previewRequestedFor !== url) {
    previewRequestedFor = url;
    previewTitle = '';
    previewDescription = '';
    previewImage = '';
    previewMediaKind = '';
    mediaActive = false;
    if (fetchMetadata && linkPreview?.shouldFetchMetadata) void fetchLinkPreview(url);
  }

  onMount(() => {
    mounted = true;
    if (typeof IntersectionObserver === 'undefined' || !previewElement) {
      previewWarmed = true;
      previewVisible = true;
      return;
    }
    prefetchObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        previewWarmed = true;
        prefetchObserver?.disconnect();
        prefetchObserver = undefined;
      },
      { rootMargin: PREFETCH_ROOT_MARGIN },
    );
    renderObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        previewVisible = true;
        renderObserver?.disconnect();
        renderObserver = undefined;
      },
      { rootMargin: RENDER_ROOT_MARGIN },
    );
    prefetchObserver.observe(previewElement);
    renderObserver.observe(previewElement);
  });

  onDestroy(() => {
    prefetchObserver?.disconnect();
    renderObserver?.disconnect();
  });

  async function fetchLinkPreview(targetUrl: string): Promise<void> {
    const meta = await loadUrlPreview(targetUrl);
    if (!meta || url !== targetUrl) return;

    const next = {
      title: meta.title?.trim() || undefined,
      description: meta.description?.trim() || undefined,
      image: meta.image?.trim() || undefined,
    };
    if (next.title) previewTitle = next.title;
    if (next.description) previewDescription = next.description;
    if (next.image) previewImage = next.image;
    if (isFetchedMediaKind(meta.mediaKind)) previewMediaKind = meta.mediaKind;
    if (next.title || next.description || next.image) dispatch('metadata', next);
  }

  function isFetchedMediaKind(kind: string | undefined): kind is 'image' | 'video' | 'audio' {
    return kind === 'image' || kind === 'video' || kind === 'audio';
  }

  function warmVideoFrame(event: Event): void {
    const video = event.currentTarget as HTMLVideoElement;
    const targetTime = videoThumbnailTime(video);
    if (video.currentTime > 0.5 || Math.abs(video.currentTime - targetTime) < 0.25) return;
    try {
      video.currentTime = targetTime;
    } catch {
      // Some remote videos disallow seeking before enough data is loaded.
      // The native video element still shows its browser-provided poster frame.
    }
  }

  function videoThumbnailTime(video: HTMLVideoElement): number {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!duration) return DEFAULT_VIDEO_THUMB_TIME;
    const target = Math.max(DEFAULT_VIDEO_THUMB_TIME, duration * 0.2);
    return Math.max(0, Math.min(target, 18, duration - 0.25));
  }

  function mediaFragmentUrl(rawUrl: string, seconds: number): string {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.hash) return rawUrl;
      parsed.hash = `t=${seconds.toFixed(1)}`;
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
</script>

<div bind:this={previewElement}>
  {#if showRichPreview}
    <div class="rich-preview" class:playing={mediaActive}>
      {#if mediaActive && effectiveKind === 'youtube' && youtubeEmbedSrc}
        <div class="inline-player">
          <iframe
            src={youtubeEmbedSrc}
            title={displayTitle}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
          ></iframe>
        </div>
      {:else if mediaActive && effectiveKind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption: friend-feed links point at arbitrary remote videos; Deepmarks has no caption track to attach. -->
        <video class="inline-video" src={url} controls autoplay preload="metadata"></video>
      {:else if mediaActive && effectiveKind === 'audio'}
        <audio class="inline-audio" src={url} controls autoplay preload="metadata"></audio>
      {:else}
        {#if previewImageUrl}
          {#if canInlinePlay}
            <button
              type="button"
              class="preview-media preview-button"
              on:click={() => (mediaActive = true)}
              aria-label="play media in feed"
            >
              <img src={previewImageUrl} alt="" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer" />
              <span class="play-badge">▶</span>
            </button>
          {:else}
            <a class="preview-media" href={safeExternalHref(url)} target="_blank" rel="noreferrer">
              <img src={previewImageUrl} alt="" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer" />
            </a>
          {/if}
        {:else if effectiveKind === 'video'}
          <button
            type="button"
            class="preview-media preview-button video-thumb"
            on:click={() => (mediaActive = true)}
            aria-label="play video in feed"
          >
            <video
              src={videoThumbnailSrc || url}
              poster={thumbnailUrl || undefined}
              muted
              playsinline
              preload="metadata"
              on:loadedmetadata={warmVideoFrame}
              on:loadeddata={warmVideoFrame}
            ></video>
            <span class="play-badge">▶</span>
          </button>
        {:else if canInlinePlay}
          <button
            type="button"
            class="preview-placeholder"
            on:click={() => (mediaActive = true)}
          >
            <span>▶</span>
            <strong>{effectiveKind === 'audio' ? 'play audio' : 'play video'}</strong>
          </button>
        {/if}
        {#if showText && displayDescription}
          <p class="preview-snippet">{displayDescription}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .rich-preview {
    width: min(100%, 540px);
    margin: 8px 0 9px;
    background: transparent;
  }
  :global(.compact) .rich-preview {
    margin: 6px 0 7px;
  }
  .preview-media {
    display: block;
    width: 100%;
    max-height: 240px;
    overflow: hidden;
    background: var(--paper-warm);
    border-radius: 6px;
    color: inherit;
    text-decoration: none;
    position: relative;
  }
  .preview-media img {
    display: block;
    width: 100%;
    max-height: 240px;
    object-fit: cover;
  }
  .video-thumb {
    min-height: 150px;
    background: #101418;
  }
  .video-thumb video {
    display: block;
    width: 100%;
    min-height: 150px;
    max-height: 240px;
    object-fit: cover;
    background: #101418;
  }
  .preview-button {
    border: 0;
    padding: 0;
    cursor: pointer;
    font: inherit;
    text-align: inherit;
  }
  .play-badge {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 42px;
    height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: rgba(8, 38, 61, 0.82);
    color: white;
    font-size: 17px;
    line-height: 1;
    padding-left: 2px;
  }
  .preview-placeholder {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 54px;
    border: 0;
    border-radius: 6px;
    padding: 12px 14px;
    background: var(--paper-warm);
    color: var(--ink-deep);
    font: inherit;
    cursor: pointer;
  }
  .preview-placeholder span {
    color: var(--link);
    font-size: 16px;
  }
  .preview-placeholder strong {
    font-size: 13px;
    font-weight: 600;
  }
  .preview-snippet {
    margin: 7px 0 0;
    padding: 0;
    color: var(--ink);
    font-size: 12px;
    line-height: 1.45;
    line-clamp: 2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .inline-player {
    aspect-ratio: 16 / 9;
    background: var(--paper-warm);
  }
  .inline-player iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .inline-video {
    display: block;
    width: 100%;
    max-height: 320px;
    background: black;
  }
  .inline-audio {
    display: block;
    width: calc(100% - 18px);
    margin: 9px;
  }
</style>
