<script lang="ts">
  // Server-side search via /search/public on payment-proxy. Backed by
  // Meilisearch with the delisted-events filter applied; supports
  // Pinboard-style modifiers (#tag, @author, site:, after:, before:,
  // sats:, saves:) parsed server-side.
  //
  // Earlier this page filtered the live feed client-side over the ~200
  // most recent events in memory — useless on a real corpus. Now we
  // hit the index directly.

  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { config } from '$lib/config';
  import Subheader from '$lib/components/Subheader.svelte';
  import LandingFeedRow from '$lib/components/LandingFeedRow.svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';

  interface Hit {
    event_id: string;
    score: number;
    doc: {
      id: string;
      url: string;
      title: string;
      description: string;
      tags: string[];
      author_pubkey: string;
      domain: string;
      created_at: number;
      zap_total: number;
      save_count: number;
    };
  }

  let hits: Hit[] = [];
  let total = 0;
  let queryTimeMs = 0;
  let loading = false;
  let error: string | null = null;
  let typed = '';

  $: query = ($page.url.searchParams.get('q') ?? '').trim();
  $: typed = query;
  $: if (query) void runSearch(query);
  $: if (!query) { hits = []; total = 0; }

  async function runSearch(q: string): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(
        `${config.apiBase}/search/public?q=${encodeURIComponent(q)}&limit=50`,
      );
      if (!res.ok) throw new Error(`search ${res.status}`);
      const json = (await res.json()) as { hits: Hit[]; total: number; query_time_ms: number };
      hits = json.hits;
      total = json.total;
      queryTimeMs = json.query_time_ms;
    } catch (e) {
      error = (e as Error).message ?? 'search failed';
    } finally {
      loading = false;
    }
  }

  function hitToBookmark(h: Hit): ParsedBookmark {
    return {
      url: h.doc.url,
      title: h.doc.title || h.doc.url,
      description: h.doc.description,
      tags: h.doc.tags ?? [],
      archivedForever: false,
      savedAt: h.doc.created_at,
      curator: h.doc.author_pubkey,
      eventId: h.event_id,
    };
  }

  function onSubmit(e: Event) {
    e.preventDefault();
    void goto(`/app/search?q=${encodeURIComponent(typed.trim())}`);
  }
</script>

<svelte:head><title>{query ? `${query} — search` : 'search'} — Deepmarks</title></svelte:head>

<Subheader context={query ? `search · "${query}"` : 'search'} />

<div class="search-form">
  <form on:submit={onSubmit}>
    <input
      type="search"
      bind:value={typed}
      placeholder="search bookmarks across the network…"
      autocomplete="off"
    />
    <button type="submit">search</button>
  </form>
</div>

{#if !query}
  <div class="hint">
    <p>Search bookmarks across your library and the network. Pinboard-style modifiers are supported:</p>
    <ul>
      <li><code>#bitcoin</code> — restrict to a tag</li>
      <li><code>@fiatjaf</code> — restrict to a curator (handle or hex pubkey)</li>
      <li><code>site:paulgraham.com</code> — restrict to a host</li>
      <li><code>after:2024-01-01</code> · <code>before:2024-12-31</code> — date range</li>
      <li><code>sats:&gt;100</code> — minimum total zaps received</li>
      <li><code>saves:&gt;5</code> — minimum number of distinct savers</li>
    </ul>
  </div>
{:else if loading}
  <p class="hint">searching…</p>
{:else if error}
  <p class="hint err">couldn't search — {error}</p>
{:else if hits.length === 0}
  <p class="hint">no matches for <code>{query}</code></p>
{:else}
  <div class="result-meta">
    {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
    · <span class="muted">{queryTimeMs} ms</span>
  </div>
  <div class="results">
    {#each hits as h (h.event_id)}
      <LandingFeedRow bookmark={hitToBookmark(h)} saveCount={h.doc.save_count} />
    {/each}
  </div>
{/if}

<style>
  .search-form { max-width: 1040px; margin: 16px auto 0; padding: 0 24px; }
  .search-form form {
    display: flex;
    gap: 8px;
    border: 1px solid var(--rule);
    border-radius: 100px;
    padding: 4px;
    background: var(--surface);
  }
  .search-form input {
    flex: 1;
    border: 0;
    background: transparent;
    color: var(--ink-deep);
    font-size: 14px;
    padding: 8px 14px;
    outline: none;
  }
  .search-form button {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 6px 18px;
    border-radius: 100px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .hint { max-width: 1040px; margin: 0 auto; padding: 24px; color: var(--ink); }
  .hint code { background: var(--paper-warm); padding: 1px 6px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; }
  .hint.err { color: var(--coral-deep); }
  ul { line-height: 1.9; padding-left: 20px; }
  .result-meta {
    max-width: 1040px;
    margin: 0 auto;
    padding: 12px 24px 4px;
    color: var(--muted);
    font-size: 12px;
  }
  .result-meta .muted { color: var(--muted); }
  .results {
    max-width: 1040px;
    margin: 0 auto;
    padding: 0 24px 60px;
  }
</style>
