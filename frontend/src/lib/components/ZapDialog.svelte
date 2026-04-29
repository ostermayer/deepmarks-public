<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { fetchAllZapInvoices, payInvoicesWithWebLN, planZap } from '$lib/nostr/zap';
  import { getProfile } from '$lib/nostr/profiles';
  import { currentSession } from '$lib/stores/session';
  import { config } from '$lib/config';

  export let bookmark: ParsedBookmark;
  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void; paid: { preimages: string[] } }>();

  let amount = 21;
  let comment = '';
  let working = false;
  let error = '';

  // Curator's Lightning address comes from their kind:0 profile (lud16).
  // Reactive store: renders the initial plan against a null value, then
  // re-renders once NDK resolves the profile. Missing values (the
  // curator hasn't published a profile or hasn't set lud16) gracefully
  // roll the 80% share into @deepmarks per planZap's fallback policy.
  $: curatorProfile = getProfile(bookmark.curator);
  $: curatorLightning = $curatorProfile?.lud16 ?? null;

  $: plan = planZap(bookmark, amount, config.deepmarksLnAddress, curatorLightning);

  // Drives the honest-copy banner below the split so the zapper knows
  // when their money is being routed to @deepmarks instead of the
  // person/site they wanted to tip.
  $: curatorUnroutable = !curatorLightning;
  $: operatorUnroutable = !bookmark.lightning;

  async function pay() {
    error = '';
    working = true;
    try {
      const session = currentSession();
      if (!session.pubkey) throw new Error('Sign in to zap.');
      const invoices = await fetchAllZapInvoices(plan, bookmark, session.pubkey, comment);
      const preimages = await payInvoicesWithWebLN(invoices);
      dispatch('paid', { preimages });
      open = false;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      working = false;
    }
  }
</script>

{#if open}
  <div
    class="backdrop"
    on:click={() => dispatch('close')}
    on:keydown={(e) => e.key === 'Escape' && dispatch('close')}
    role="presentation"
  >
    <div
      class="dialog"
      on:click|stopPropagation
      on:keydown|stopPropagation
      role="dialog"
      aria-modal="true"
      aria-labelledby="zap-title"
      tabindex="-1"
    >
      <h3 id="zap-title">⚡ zap this bookmark</h3>
      <div class="bookmark">
        <strong>{bookmark.title}</strong>
        <span>{bookmark.url}</span>
      </div>

      <label class="field">
        <span>amount (sats)</span>
        <div class="presets">
          {#each [21, 100, 500, 1000, 21000] as preset}
            <button type="button" class:active={amount === preset} on:click={() => (amount = preset)}>
              {preset.toLocaleString()}
            </button>
          {/each}
          <input type="number" min="1" bind:value={amount} />
        </div>
      </label>

      <label class="field">
        <span>note (optional)</span>
        <input type="text" bind:value={comment} placeholder="great link, thanks" />
      </label>

      <div class="split">
        <h4>split</h4>
        {#each plan.recipients as r}
          <div class="row">
            <span>{r.label}</span>
            <strong>{(r.millisats / 1000).toLocaleString()} sats</strong>
          </div>
        {/each}
      </div>

      {#if curatorUnroutable || operatorUnroutable}
        <p class="fallback-note">
          {#if curatorUnroutable && operatorUnroutable}
            neither the curator nor the site publishes a Lightning address, so the full amount goes to @deepmarks.
          {:else if curatorUnroutable}
            the curator hasn't set a Lightning address on their Nostr profile — their share rolls into @deepmarks.
          {:else}
            couldn't detect a Lightning address on the site, so the operator share rolls into @deepmarks.
          {/if}
        </p>
      {/if}

      {#if error}<div class="error">{error}</div>{/if}

      <div class="actions">
        <button type="button" class="ghost" on:click={() => dispatch('close')} disabled={working}>cancel</button>
        <button type="button" class="primary pixel-press" on:click={pay} disabled={working || amount < 1}>
          {working ? 'paying…' : `zap ${amount} sats`}
        </button>
      </div>
      <p class="muted">
        your wallet pays {plan.recipients.length} invoice{plan.recipients.length === 1 ? '' : 's'}.
        deepmarks never holds your sats.
      </p>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(13, 62, 92, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    background: var(--surface);
    border-radius: 12px;
    padding: 24px;
    width: min(440px, 92vw);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  }
  h3 {
    margin: 0 0 12px;
    color: var(--ink-deep);
    font-size: 18px;
  }
  .bookmark {
    background: var(--paper-warm);
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 16px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .bookmark strong { color: var(--ink-deep); }
  .bookmark span { color: var(--muted); font-family: 'Courier New', monospace; font-size: 10px; word-break: break-all; }
  .field { display: block; margin-bottom: 14px; }
  .field span { display: block; font-size: 12px; color: var(--ink-deep); margin-bottom: 6px; font-weight: 500; }
  .field input[type='text'], .field input[type='number'] {
    padding: 7px 10px; border: 1px solid var(--rule); border-radius: 6px;
    background: var(--surface); color: var(--ink); font-family: inherit; font-size: 13px;
    width: 100%;
  }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .presets button {
    background: var(--surface); border: 1px solid var(--rule); border-radius: 100px;
    padding: 4px 10px; font-size: 11px; cursor: pointer; color: var(--ink); font-family: inherit;
  }
  .presets button.active { border-color: var(--zap); color: var(--zap); font-weight: 600; }
  .presets input { width: 100px !important; }
  .split { background: var(--paper-warm); border-radius: 8px; padding: 10px 12px; margin: 14px 0; }
  .split h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  .split .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  .split .row span { color: var(--muted); }
  .split .row strong { color: var(--ink-deep); }
  .fallback-note {
    font-size: 11px;
    color: var(--muted);
    background: var(--paper-warm);
    border-left: 2px solid var(--rule);
    padding: 8px 10px;
    margin: -6px 0 12px;
    border-radius: 4px;
    line-height: 1.4;
  }
  .error { padding: 10px 12px; background: var(--coral-soft); color: var(--coral-deep); border-radius: 8px; font-size: 12px; margin-bottom: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
  .primary { background: var(--zap); color: #1a0f0c; border: 0; padding: 8px 16px; border-radius: 100px; font-weight: 600; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: #d97706; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .muted { color: var(--muted); font-size: 11px; margin: 0; text-align: center; }
</style>
