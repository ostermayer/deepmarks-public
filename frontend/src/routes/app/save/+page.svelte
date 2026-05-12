<script lang="ts">
  // Share-sheet landing page. Reachable via:
  //   - /app/save?url=https://example.com/article (web direct link)
  //   - deepmarks://save?url=… (iOS Share Extension + Android SEND
  //     intent → Capacitor's appUrlOpen handler routes here)
  //
  // Mounts SaveBox with the URL prefilled. SaveBox auto-fetches title
  // / description / suggested tags on mount when prefillUrl is set so
  // the form is populated by the time the user looks at it.
  //
  // After save we dispatch the user back to /app/bookmarks — the recent
  // bookmarks feed surfaces the just-saved entry as the freshest row.

  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { isAuthenticated } from '$lib/stores/session';
  import Header from '$lib/components/Header.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import SaveBox from '$lib/components/SaveBox.svelte';

  $: prefillUrl = $page.url.searchParams.get('url') ?? '';

  // Not signed in — bounce to login with a return path that brings
  // the URL back here after auth completes. Loses the URL otherwise.
  onMount(() => {
    if (!$isAuthenticated && prefillUrl) {
      const next = encodeURIComponent(`/app/save?url=${encodeURIComponent(prefillUrl)}`);
      void goto(`/login?next=${next}`, { replaceState: true });
    }
  });

  function onSaved() {
    void goto('/app/bookmarks', { replaceState: true });
  }
</script>

<svelte:head><title>save bookmark — Deepmarks</title></svelte:head>

<Header />

<main class="page">
  <header class="head">
    <h1>save bookmark</h1>
    {#if prefillUrl}
      <p class="src">
        shared from <code>{(() => { try { return new URL(prefillUrl).host; } catch { return prefillUrl; } })()}</code>
      </p>
    {:else}
      <p class="src muted">no URL was passed — enter one below.</p>
    {/if}
  </header>

  {#if $isAuthenticated}
    <SaveBox {prefillUrl} on:saved={onSaved} />
  {:else if !prefillUrl}
    <p class="hint">sign in first.</p>
  {/if}
</main>

<Footer />

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px;
  }
  .head {
    margin-bottom: 20px;
  }
  .head h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 22px;
    color: var(--ink-deep);
    margin: 0 0 6px;
    letter-spacing: -0.3px;
  }
  .src {
    color: var(--ink);
    font-size: 13px;
    margin: 0;
  }
  .src code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--ink-deep);
  }
  .muted {
    color: var(--muted);
  }
  .hint {
    color: var(--muted);
    font-size: 13px;
    padding: 16px 0;
  }
</style>
