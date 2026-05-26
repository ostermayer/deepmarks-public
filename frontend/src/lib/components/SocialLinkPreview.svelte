<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { loadUrlPreview } from '$lib/metadata/url-preview-cache';
  import { describeLinkPreview, youtubeEmbedUrl } from '$lib/metadata/link-preview';

  export let url = '';
  export let title = '';
  export let description = '';

  const dispatch = createEventDispatcher<{
    metadata: { title?: string; description?: string; image?: string };
  }>();

  let mounted = false;
  let previewRequestedFor = '';
  let previewTitle = '';
  let previewDescription = '';
  let previewImage = '';
  let mediaActive = false;
  let previewVisible = false;
  let previewElement: HTMLDivElement | undefined;
  let previewObserver: IntersectionObserver | undefined;

  $: linkPreview = describeLinkPreview(url);
  $: displayTitle = previewTitle || title;
  $: displayDescription = previewDescription || description;
  $: previewImageUrl = previewImage || linkPreview?.thumbnailUrl || '';
  $: canInlinePlay = linkPreview?.kind === 'youtube' || linkPreview?.kind === 'video' || linkPreview?.kind === 'audio';
  $: showRichPreview = !!linkPreview && (
    !!previewImageUrl ||
    canInlinePlay ||
    !!displayDescription
  );
  $: youtubeEmbedSrc = linkPreview?.youtubeId ? youtubeEmbedUrl(linkPreview.youtubeId) : '';

  $: if (mounted && previewVisible && url && previewRequestedFor !== url) {
    previewRequestedFor = url;
    previewTitle = '';
    previewDescription = '';
    previewImage = '';
    mediaActive = false;
    if (linkPreview?.shouldFetchMetadata) void fetchLinkPreview(url);
  }

  onMount(() => {
    mounted = true;
    if (!linkPreview?.shouldFetchMetadata) {
      previewVisible = true;
      return;
    }
    if (typeof IntersectionObserver === 'undefined' || !previewElement) {
      previewVisible = true;
      return;
    }
    previewObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        previewVisible = true;
        previewObserver?.disconnect();
        previewObserver = undefined;
      },
      { rootMargin: '420px 0px' },
    );
    previewObserver.observe(previewElement);
  });

  onDestroy(() => {
    previewObserver?.disconnect();
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
    if (next.title || next.description || next.image) dispatch('metadata', next);
  }
</script>

<div bind:this={previewElement}>
  {#if showRichPreview}
    <div class="rich-preview" class:playing={mediaActive}>
      {#if mediaActive && linkPreview?.kind === 'youtube' && youtubeEmbedSrc}
        <div class="inline-player">
          <iframe
            src={youtubeEmbedSrc}
            title={displayTitle}
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
          ></iframe>
        </div>
      {:else if mediaActive && linkPreview?.kind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption: friend-feed links point at arbitrary remote videos; Deepmarks has no caption track to attach. -->
        <video class="inline-video" src={url} controls autoplay preload="metadata"></video>
      {:else if mediaActive && linkPreview?.kind === 'audio'}
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
              <img src={previewImageUrl} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <span class="play-badge">▶</span>
            </button>
          {:else}
            <a class="preview-media" href={url} target="_blank" rel="noreferrer">
              <img src={previewImageUrl} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </a>
          {/if}
        {:else if canInlinePlay}
          <button
            type="button"
            class="preview-placeholder"
            on:click={() => (mediaActive = true)}
          >
            <span>▶</span>
            <strong>{linkPreview?.kind === 'audio' ? 'play audio' : 'play video'}</strong>
          </button>
        {/if}
        {#if displayDescription}
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
    border: 1px solid var(--rule);
    background: var(--surface);
    border-radius: 6px;
    overflow: hidden;
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
    margin: 0;
    padding: 9px 12px 10px;
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
