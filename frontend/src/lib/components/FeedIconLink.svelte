<script lang="ts">
  import { Rss } from 'lucide-svelte';
  import { isNativeShell } from '$lib/native/runtime';

  export let href: string = '';
  export let label: string = 'Atom feed';

  $: showFeedLink = !!href && !isNativeShell();
</script>

<svelte:head>
  {#if showFeedLink}
    <link rel="alternate" type="application/atom+xml" title={label} href={href} />
  {/if}
</svelte:head>

{#if showFeedLink}
  <a class="feed-link" {href} target="_blank" rel="noreferrer" title={label} aria-label={label}>
    <Rss size={15} strokeWidth={2.4} />
  </a>
{/if}

<style>
  .feed-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: 0 0 auto;
    border-radius: 4px;
    color: #f59e0b;
    text-decoration: none;
  }
  .feed-link:hover {
    color: var(--coral-deep);
    background: var(--paper);
    text-decoration: none;
  }
</style>
