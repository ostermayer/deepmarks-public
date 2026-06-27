<script lang="ts">
  // Renders a Nostr note (typically kind:1) that a user has bookmarked
  // via their NIP-51 list. The server-side follows ingester should have
  // already mirrored these targets into our relay; unresolved targets
  // stay hidden instead of showing raw ids or "resolving" placeholders.
  //
  // Interaction model:
  //   - Click anywhere on the card body → open nostr:<nevent> so the
  //     user's default Nostr app/client can handle it.
  //   - Click the small ↗ icon → open the note on primal.net as a web
  //     fallback for replies / full thread.

  import { createEventDispatcher } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import Avatar from './Avatar.svelte';
  import NostrText from './NostrText.svelte';
  import SocialLinkPreview from './SocialLinkPreview.svelte';
  import { resolveEvent } from '$lib/nostr/event-resolver';
  import { getProfile } from '$lib/nostr/profiles';
  import { extractHttpUrls } from '$lib/nostr/social-links';
  import { relativeTime } from '$lib/util/time';

  /** Target event id (hex) — the thing the user bookmarked. */
  export let targetEventId: string;
  export let zapSats: number = 0;
  export let savedByPubkey: string = '';
  export let savedAt: number | undefined = undefined;
  export let clamp: boolean = true;
  export let showLinkPreviews: boolean = false;
  export let embedded: boolean = false;

  const dispatch = createEventDispatcher<{ invalid: { targetEventId: string; kind: number } }>();
  let invalidDispatchedFor = '';

  $: event = resolveEvent(targetEventId);
  $: authorProfile = $event?.pubkey ? getProfile($event.pubkey) : null;
  $: savedByProfile = savedByPubkey ? getProfile(savedByPubkey) : null;

  $: authorLabel = (() => {
    const display = $authorProfile?.name || $authorProfile?.displayName;
    if (display) return display;
    const pk = $event?.pubkey;
    if (!pk) return '';
    return shortPubkey(pk);
  })();

  $: savedByLabel = savedByPubkey
    ? ($savedByProfile?.name || $savedByProfile?.displayName || shortPubkey(savedByPubkey))
    : '';
  $: savedByHref = savedByPubkey ? profileHref(savedByPubkey) : '';

  $: authorHref = (() => {
    const pk = $event?.pubkey;
    if (!pk) return undefined;
    try { return `/u/${nip19.npubEncode(pk)}`; }
    catch { return `/u/${pk}`; }
  })();

  // Primal web view URL. Primal accepts either bech32 note1 or hex.
  $: primalHref = (() => {
    try { return `https://primal.net/e/${nip19.noteEncode(targetEventId)}`; }
    catch { return `https://primal.net/e/${targetEventId}`; }
  })();

  $: noteUrls = showLinkPreviews && $event
    ? extractHttpUrls($event.content).slice(0, 3)
    : [];

  $: nostrHref = (() => {
    try {
      return `nostr:${nip19.neventEncode({
        id: targetEventId,
        relays: ['wss://relay.deepmarks.org'],
      })}`;
    } catch {
      try { return `nostr:${nip19.noteEncode(targetEventId)}`; }
      catch { return `nostr:${targetEventId}`; }
    }
  })();

  $: if ($event?.kind !== undefined && $event.kind !== 1 && invalidDispatchedFor !== targetEventId) {
    invalidDispatchedFor = targetEventId;
    dispatch('invalid', { targetEventId, kind: $event.kind });
  }

  function openNostrApp(): void {
    window.location.href = nostrHref;
  }

  function shortPubkey(pk: string): string {
    try { return `${nip19.npubEncode(pk).slice(0, 12)}…`; }
    catch { return pk.slice(0, 8); }
  }

  function profileHref(pk: string): string {
    try { return `/u/${nip19.npubEncode(pk)}`; }
    catch { return `/u/${pk}`; }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openNostrApp();
    }
  }
</script>

{#if $event?.kind === 1}
<div
  class="note"
  class:embedded
  role="link"
  tabindex="0"
  title="open in your Nostr app"
  on:click={openNostrApp}
  on:keydown={onKey}
>
  <span class="avatar-wrap">
    <Avatar pubkey={$event.pubkey} size={28} label={authorLabel} />
  </span>
  <div class="body">
    <div class="head">
      {#if authorHref}
        <a
          class="author"
          href={authorHref}
          on:click|stopPropagation
        >{authorLabel}</a>
      {:else}
        <span class="author">{authorLabel}</span>
      {/if}
      <span class="dot">·</span>
      <span class="when">{relativeTime($event.created_at)}</span>
      {#if zapSats > 0}
        <span class="dot">·</span>
        <span class="zap"><span aria-hidden="true">⚡</span> {zapSats.toLocaleString()} sats</span>
      {/if}
      <a
        class="primal-link"
        href={primalHref}
        target="_blank"
        rel="noreferrer"
        title="open on primal — see replies, reactions, full thread"
        on:click|stopPropagation
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M6 2h8v8M14 2 6 10M3 5v8a1 1 0 0 0 1 1h8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </a>
    </div>
    <div class="content" class:clamp>
      <NostrText text={$event.content} />
    </div>
    {#if noteUrls.length > 0}
      <div class="note-links" role="presentation" on:click|stopPropagation on:keydown|stopPropagation>
        {#each noteUrls as url}
          <SocialLinkPreview {url} fetchMetadata showText={false} />
        {/each}
      </div>
    {/if}
    {#if savedByPubkey && savedByLabel}
      <div class="saved-by">
        saved by
        <a href={savedByHref} on:click|stopPropagation>{savedByLabel}</a>
        {#if savedAt}
          <span>·</span>
          <span>{relativeTime(savedAt)}</span>
        {/if}
      </div>
    {/if}
  </div>
</div>
{/if}

<style>
  .note {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--ink) 22%, var(--rule));
    cursor: pointer;
  }
  .note:last-child { border-bottom: 0; }
  .note.embedded {
    padding: 0;
    border-bottom: 0;
  }
  .note:hover .content { color: var(--ink-deep); }
  .avatar-wrap {
    flex-shrink: 0;
    line-height: 0;
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .author {
    color: var(--ink-deep);
    font-weight: 600;
    text-decoration: none;
    font-size: 12px;
  }
  .author:hover { color: var(--coral); text-decoration: underline; }
  .dot { color: var(--rule); }
  .when { color: var(--muted); }
  .zap {
    color: var(--zap);
    font-weight: 600;
  }
  .primal-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: var(--muted);
    text-decoration: none;
    transition: color 0.15s, background 0.15s;
  }
  .primal-link:hover {
    color: var(--coral);
    background: var(--coral-soft);
  }
  .content {
    margin-top: 4px;
    color: var(--ink);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .content.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .note-links {
    margin-top: 7px;
  }
  .saved-by {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
    color: var(--muted);
    font-size: 11px;
  }
  .saved-by a {
    color: var(--ink-deep);
    font-weight: 600;
    text-decoration: none;
  }
  .saved-by a:hover {
    color: var(--coral);
    text-decoration: underline;
  }
</style>
