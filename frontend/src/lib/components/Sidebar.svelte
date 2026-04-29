<script lang="ts">
  // Right-rail sidebar. All data is optional and defaults to a graceful
  // "—" rather than fabricated numbers. Callers wire whichever panels
  // they have real data for:
  //   - tagCloud:  compute with tagCloudFrom() over a live feed
  //   - stats:     userStatsFrom() over the signed-in user's own bookmarks
  //   - relays:    from the NDK pool's connected-relay list
  //
  // The upgrade CTA is hidden for lifetime members — they're the target
  // audience that already converted, no reason to keep pitching.

  import { derived } from 'svelte/store';
  import type { TagCloudItem } from '$lib/nostr/tag-cloud';
  import type { UserStats } from '$lib/nostr/user-stats';
  import { session } from '$lib/stores/session';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import GlobalPanel from './GlobalPanel.svelte';

  export let tagCloud: TagCloudItem[] | null = null;
  export let stats: UserStats | null = null;
  export let relays: { url: string; ok: boolean }[] | null = null;
  /** Controls whether the "your bookmarks" stats block renders at all. */
  export let showStats: boolean = true;

  // Shows upgrade CTA only for signed-in non-members. Anonymous viewers
  // also see it (they may want to sign in + upgrade).
  $: isLifetime = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: showUpgrade = !(isLifetime && $isLifetime);

  function formatNumber(n: number | null): string {
    return n === null ? '—' : n.toLocaleString();
  }
</script>

<div class="sidebar">
  {#if tagCloud !== null}
    <div class="sidebar-section">
      <h3>tags</h3>
      {#if tagCloud.length > 0}
        <div class="tagcloud">
          {#each tagCloud as t}
            <a href={`/app/tags/${encodeURIComponent(t.name)}`} class={`s${t.weight}`}>{t.name}</a>
          {/each}
        </div>
      {:else}
        <div class="muted">no tags yet</div>
      {/if}
    </div>
  {/if}

  {#if showStats && stats !== null}
    <div class="sidebar-section">
      <h3>your bookmarks</h3>
      <div class="stats">
        <div><span>bookmarks</span><strong class="num-retro">{formatNumber(stats.marked)}</strong></div>
        <div><span>archived</span><strong class="num-retro">{formatNumber(stats.archivedForever)}</strong></div>
        <div><span>tags used</span><strong class="num-retro">{formatNumber(stats.tagsUsed)}</strong></div>
        <div class="link-row"><a href="/app/zaps">⚡ my zaps →</a></div>
      </div>
    </div>
  {/if}

  {#if showUpgrade}
    <div class="sidebar-section">
      <a href="/app/upgrade" class="upgrade-cta">upgrade →</a>
    </div>
  {/if}

  {#if relays !== null && relays.length > 0}
    <div class="sidebar-section relay-status">
      <h3>relays</h3>
      <div class="stats">
        {#each relays as r}
          <div>
            <span>{r.url.replace(/^wss:\/\//, '')}</span>
            <span class={r.ok ? 'dot-on' : 'dot-off'}>●</span>
          </div>
        {/each}
        <div style="margin-top: 8px"><a href="/app/settings">+ add relay</a></div>
      </div>
    </div>
  {/if}

  <GlobalPanel />
</div>

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
  }
  .sidebar h3 {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0 0 10px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  .sidebar-section {
    margin-bottom: 26px;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .tagcloud {
    line-height: 2;
  }
  .tagcloud a {
    display: inline-block;
    margin-right: 8px;
    color: var(--link);
  }
  .tagcloud a:hover {
    color: var(--coral);
    text-decoration: none;
  }
  .tagcloud .s1 {
    font-size: 10px;
    color: var(--muted);
  }
  .tagcloud .s2 {
    font-size: 12px;
  }
  .tagcloud .s3 {
    font-size: 14px;
    font-weight: 600;
  }
  .tagcloud .s4 {
    font-size: 18px;
    font-weight: 600;
  }
  .tagcloud .s5 {
    font-size: 22px;
    font-weight: 700;
    color: var(--ink-deep);
  }
  .stats {
    font-size: 12px;
  }
  .stats div {
    padding: 3px 0;
    display: flex;
    justify-content: space-between;
  }
  .stats span {
    color: var(--muted);
  }
  .stats strong {
    color: var(--ink);
    font-weight: 600;
  }
  .stats .link-row {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--rule);
  }
  .stats .link-row a {
    color: var(--zap);
    font-weight: 500;
    text-decoration: none;
  }
  .stats .link-row a:hover { color: var(--coral); }
  .upgrade-cta {
    display: block;
    text-align: center;
    background: var(--coral);
    color: var(--on-coral) !important;
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.2px;
    padding: 12px 16px;
    border: 2px solid var(--coral-deep);
    box-shadow: 3px 3px 0 var(--ink-deep);
    text-decoration: none;
    transition: transform 80ms ease-out, box-shadow 80ms ease-out;
  }
  .upgrade-cta:hover {
    transform: translate(-1px, -1px);
    box-shadow: 4px 4px 0 var(--ink-deep);
    text-decoration: none;
  }
  .relay-status .dot-on {
    color: var(--archive);
  }
  .relay-status .dot-off {
    color: var(--muted);
  }
  @media (max-width: 720px) {
    .sidebar {
      width: 100%;
    }
  }
</style>
