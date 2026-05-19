<script lang="ts">
  // Renders a Nostr note (typically kind:1) that a user has bookmarked
  // via their NIP-51 list. The note content is fetched lazily via
  // event-resolver.ts; until it resolves we show a skeleton row so the
  // list layout doesn't reflow when the content lands.
  //
  // Interaction model:
  //   - Click anywhere on the card body → open nostr:<nevent> so the
  //     user's default Nostr app/client can handle it.
  //   - Click the small ↗ icon → open the note on primal.net as a web
  //     fallback for replies / full thread.

  import { createEventDispatcher } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import Avatar from './Avatar.svelte';
  import { resolveEvent } from '$lib/nostr/event-resolver';
  import { getProfile } from '$lib/nostr/profiles';
  import { relativeTime } from '$lib/util/time';

  /** Target event id (hex) — the thing the user bookmarked. */
  export let targetEventId: string;

  const dispatch = createEventDispatcher<{ invalid: { targetEventId: string; kind: number } }>();
  let invalidDispatchedFor = '';

  $: event = resolveEvent(targetEventId);
  $: authorProfile = $event?.pubkey ? getProfile($event.pubkey) : null;

  $: authorLabel = (() => {
    const display = $authorProfile?.displayName;
    if (display) return display;
    const pk = $event?.pubkey;
    if (!pk) return '';
    try { return `${nip19.npubEncode(pk).slice(0, 12)}…`; }
    catch { return pk.slice(0, 8); }
  })();

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

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openNostrApp();
    }
  }
</script>

{#if !$event || $event.kind === 1}
<div
  class="note"
  role="link"
  tabindex="0"
  title="open in your Nostr app"
  on:click={openNostrApp}
  on:keydown={onKey}
>
  {#if $event}
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
      <div class="content clamp">
        {$event.content}
      </div>
    </div>
  {:else}
    <span class="avatar-wrap skeleton-avatar" aria-hidden="true"></span>
    <div class="body">
      <div class="head">
        <span class="skeleton-line skeleton-short"></span>
      </div>
      <div class="skeleton-line skeleton-wide"></div>
      <div class="skeleton-line skeleton-wide"></div>
      <div class="head" style="margin-top: 4px;">
        <span class="muted-id">note {targetEventId.slice(0, 10)}… resolving</span>
      </div>
    </div>
  {/if}
</div>
{/if}

<style>
  .note {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 1px dashed var(--rule);
    cursor: pointer;
  }
  .note:last-child { border-bottom: 0; }
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
  /* Skeleton placeholders while resolveEvent is in flight. */
  .skeleton-avatar {
    display: inline-block;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--paper-warm);
  }
  .skeleton-line {
    display: block;
    height: 10px;
    border-radius: 4px;
    background: var(--paper-warm);
    margin: 4px 0;
  }
  .skeleton-short { width: 40%; }
  .skeleton-wide { width: 92%; }
  .muted-id {
    font-family: 'Courier New', monospace;
    font-size: 10px;
    color: var(--muted);
  }
</style>
