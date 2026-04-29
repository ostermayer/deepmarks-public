<script lang="ts">
  // Settings: list + manage muted pubkeys.
  //
  // Reads the same `muteList` store the feed filters from, so muting
  // here and muting from a row both surface in this list. Click
  // "unmute" to drop a pubkey and republish kind:10000.

  import { session } from '$lib/stores/session';
  import { muteList, unmutePubkey } from '$lib/nostr/mute-list';
  import MuteRow from './MuteRow.svelte';

  $: pubkey = $session.pubkey ?? null;
  $: list = $muteList;

  let busy: string | null = null;
  let error = '';

  async function unmute(target: string) {
    if (!pubkey) return;
    busy = target;
    error = '';
    try {
      await unmutePubkey(target, pubkey);
    } catch (e) {
      error = (e as Error).message ?? 'unmute failed';
    } finally {
      busy = null;
    }
  }

</script>

<section>
  <h2>muted accounts</h2>

  {#if !pubkey}
    <p class="muted">sign in to manage your mute list.</p>
  {:else if list.pubkeys.size === 0}
    <p class="muted">you haven't muted anyone yet. mute curators from any bookmark row's ⋯ menu.</p>
  {:else}
    <ul class="mute-list">
      {#each [...list.pubkeys] as p (p)}
        <MuteRow pubkey={p} busy={busy === p} on:unmute={() => void unmute(p)} />
      {/each}
    </ul>
  {/if}

  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  section { margin-top: 32px; }
  section h2 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--ink-deep);
    letter-spacing: 1.5px;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  .muted { color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0; }
  .mute-list { list-style: none; padding: 0; margin: 0; }
  .mute-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px dashed var(--rule);
  }
  .who {
    font-size: 13px;
    color: var(--ink-deep);
    word-break: break-all;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink-deep);
    padding: 4px 12px;
    border-radius: 100px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .ghost:hover:not(:disabled) { border-color: var(--coral); color: var(--coral-deep); }
  .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .err { color: #a33; font-size: 12px; margin: 10px 0 0; }
</style>
