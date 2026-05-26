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
  // Pending shares from the iOS Share Extension are now drained
  // silently in $lib/mobile/share-drain — this page redirects away
  // immediately if it sees a pendingShareId in the URL, so a stale
  // URL preserved across a reload (iOS WKWebView state restoration)
  // can never strand the user on a "Saving..." form.

  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { isAuthenticated, sessionRestoring } from '$lib/stores/session';
  import SaveBox from '$lib/components/SaveBox.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { rememberOwnBookmark } from '$lib/stores/own-bookmarks';
  import { isNativeShell } from '$lib/native/runtime';

  let mounted = false;
  let redirectedToLogin = false;
  let redirectedFromPendingShare = false;
  let nativeShell = isNativeShell();

  $: pendingShareId = $page.url.searchParams.get('pendingShareId') ?? '';
  $: queryUrl = $page.url.searchParams.get('url') ?? '';
  $: queryTitle = $page.url.searchParams.get('title') ?? '';
  $: queryDescription = $page.url.searchParams.get('description') ?? '';
  $: queryTags = $page.url.searchParams.get('tags') ?? '';
  $: queryVisibility = $page.url.searchParams.get('visibility');
  $: queryReadLater = $page.url.searchParams.get('readLater');
  $: prefillUrl = queryUrl;
  $: prefillTitle = queryTitle;
  $: prefillDescription = queryDescription;
  $: prefillTags = parseTags(queryTags);
  $: prefillVisibility = parseVisibility(queryVisibility);
  $: prefillReadLater = parseReadLater(queryReadLater);
  $: autoSave = $page.url.searchParams.get('autosave') === '1';

  onMount(() => {
    mounted = true;
    nativeShell = isNativeShell();
  });

  // Pending share processing happens silently via $lib/mobile/share-drain
  // on cold start, on app foreground, and on incoming
  // deepmarks://save?pendingShareId=… deep links. If /save is reached
  // with a pendingShareId at all — stale URL from before the drain
  // rollout, iOS WKWebView state restoration after a reload, or any
  // other path — redirect to /app/bookmarks and kick the drain so the
  // user never sees a stranded "Saving..." form.
  $: if (mounted && pendingShareId && !redirectedFromPendingShare) {
    redirectedFromPendingShare = true;
    void redirectAndDrain();
  }

  async function redirectAndDrain(): Promise<void> {
    try {
      const { drainPendingShares } = await import('$lib/mobile/share-drain');
      void drainPendingShares();
    } catch {
      // Even without a drain, the user shouldn't be stuck on this page.
    }
    void goto('/app/bookmarks', { replaceState: true });
  }

  $: if (mounted && prefillUrl && !$sessionRestoring && !$isAuthenticated && !redirectedToLogin) {
    redirectedToLogin = true;
    const redirect = encodeURIComponent(`/app/save${$page.url.search}`);
    void goto(`/login?redirect=${redirect}`, { replaceState: true });
  }

  function onSaved(event: CustomEvent<{ bookmark: ParsedBookmark; isPublic: boolean }>) {
    const { bookmark, isPublic } = event.detail;
    rememberOwnBookmark(bookmark, isPublic);
    void goto('/app/bookmarks', { replaceState: true });
  }

  async function onCancelled() {
    void goto('/app/bookmarks', { replaceState: true });
  }

  function parseTags(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/[\s,]+/)) {
      const tag = part.trim().replace(/^#/, '').toLowerCase();
      if (!tag || seen.has(tag) || tag.length > 48) continue;
      seen.add(tag);
      out.push(tag);
    }
    return out;
  }

  function parseVisibility(raw: string | null): 'default' | 'public' | 'private' {
    return raw === 'public' || raw === 'private' ? raw : 'default';
  }

  function parseReadLater(raw: string | null): boolean | null {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return null;
  }
</script>

<svelte:head><title>save bookmark — Deepmarks</title></svelte:head>

<main class="page" class:native={nativeShell}>
  {#if !nativeShell}
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
  {/if}

  {#if pendingShareId}
    <!-- Pending-share URL detected: silent drain handles the save and
         we redirect away. Brief placeholder so the user never sees a
         half-rendered Saving... form. -->
    <p class="hint">opening your bookmarks…</p>
  {:else if $isAuthenticated}
    <SaveBox
      {prefillUrl}
      {prefillTitle}
      {prefillDescription}
      {prefillTags}
      {prefillVisibility}
      {prefillReadLater}
      {autoSave}
      nativeMode={nativeShell}
      on:saved={onSaved}
      on:cancelled={onCancelled}
    />
  {:else if prefillUrl && $sessionRestoring}
    <p class="hint">restoring your signer before saving…</p>
  {:else if !prefillUrl}
    <p class="hint">sign in first.</p>
  {/if}
</main>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px;
  }
  .page.native {
    max-width: 760px;
    padding: 18px 20px 34px;
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
