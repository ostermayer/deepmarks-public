<script lang="ts">
  // Single muted-curator row in MuteListSection. Lives in its own
  // component so we can subscribe to per-row profile stores at the
  // component's top level — Svelte 5 disallows reactive store
  // subscriptions inside #each blocks.

  import { createEventDispatcher } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { getProfile } from '$lib/nostr/profiles';

  export let pubkey: string;
  export let busy: boolean = false;

  const dispatch = createEventDispatcher<{ unmute: void }>();

  $: profile = getProfile(pubkey);

  function shortNpub(p: string): string {
    try { return nip19.npubEncode(p).slice(0, 14) + '…'; }
    catch { return p.slice(0, 12); }
  }
</script>

<li>
  <span class="who">{$profile?.displayName || $profile?.name || shortNpub(pubkey)}</span>
  <button
    type="button"
    class="ghost"
    on:click={() => dispatch('unmute')}
    disabled={busy}
  >{busy ? '…' : 'unmute'}</button>
</li>

<style>
  li {
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
</style>
