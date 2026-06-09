<script lang="ts">
  import NostrProfileRef from './NostrProfileRef.svelte';
  import { parseNostrText } from '$lib/nostr/text-refs';

  export let text = '';

  $: parts = parseNostrText(text);
</script>

<span class="nostr-text">
  {#each parts as part}
    {#if part.type === 'text'}
      {part.text}
    {:else if part.type === 'profile'}
      <NostrProfileRef pubkey={part.pubkey} href={part.href} />
    {:else if part.type === 'url'}
      <a class="nostr-ref url" href={part.href} target="_blank" rel="noreferrer" on:click|stopPropagation>{part.text}</a>
    {:else}
      <a class="nostr-ref event" href={part.href} target="_blank" rel="noreferrer" title={part.text} on:click|stopPropagation>{part.label}</a>
    {/if}
  {/each}
</span>

<style>
  .nostr-text {
    white-space: inherit;
    overflow-wrap: anywhere;
  }
  .nostr-ref {
    color: var(--link);
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .nostr-ref:hover {
    color: var(--coral);
    text-decoration: underline;
  }
  .event {
    white-space: nowrap;
  }
</style>
