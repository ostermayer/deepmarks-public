<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { purchaseArchive, type ArchiveProgress } from '$lib/nostr/archive';
  import { currentSession, session as sessionStore } from '$lib/stores/session';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { config } from '$lib/config';

  export let url: string;
  export let tier: 'private' | 'public' = 'private';
  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void; done: { hash: string; wayback?: string } }>();

  let working = false;
  let error = '';
  let progress: ArchiveProgress[] = [];

  $: latest = progress.at(-1);
  $: lifetimeStatus = $sessionStore.pubkey ? getLifetimeStatus($sessionStore.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);

  async function buy() {
    error = '';
    progress = [];
    working = true;
    try {
      const session = currentSession();
      if (!session.pubkey) throw new Error('Sign in to archive.');
      const iter = purchaseArchive({ url, tier, pubkey: session.pubkey, lifetime: isLifetime });
      let outcome: { hash: string; wayback?: string } | null = null;
      while (true) {
        const next = await iter.next();
        if (next.done) {
          outcome = {
            hash: next.value.status.blossomHash ?? '',
            wayback: next.value.status.waybackUrl
          };
          break;
        }
        progress = [...progress, next.value];
      }
      dispatch('done', outcome!);
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
      aria-labelledby="archive-title"
      tabindex="-1"
    >
      <h3 id="archive-title">archive forever{isLifetime ? '' : ` · ${config.archivePriceSats} sats`}</h3>
      {#if isLifetime}
        <p class="lifetime-note">free for lifetime members — no payment needed.</p>
      {/if}
      <p class="url">{url}</p>

      <div class="tier-row">
        <label>
          <input type="radio" bind:group={tier} value="private" />
          🔒 private archive (encrypted, mirrored to 4 Blossom servers)
        </label>
        <label>
          <input type="radio" bind:group={tier} value="public" />
          🌍 public archive (plaintext, federates freely)
        </label>
      </div>

      {#if progress.length > 0}
        <div class="progress">
          <h4>progress</h4>
          {#each progress as p}
            <div class="step"><strong>{p.state}</strong>{p.detail ? ` — ${p.detail}` : ''}</div>
          {/each}
        </div>
      {/if}

      {#if error}<div class="error">{error}</div>{/if}

      <div class="actions">
        <button class="ghost" type="button" on:click={() => dispatch('close')} disabled={working}>cancel</button>
        <button class="primary pixel-press" type="button" on:click={buy} disabled={working}>
          {working ? (latest?.state ?? 'working…') : (isLifetime ? 'archive now' : `pay ${config.archivePriceSats} sats`)}
        </button>
      </div>
      {#if !isLifetime}
        <p class="muted">
          we render the snapshot before charging. if the page can't be archived (paywall, JS-only render),
          you're not billed.
        </p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(13, 62, 92, 0.55); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .dialog { background: var(--surface); border-radius: 12px; padding: 24px; width: min(440px, 92vw); box-shadow: 0 16px 48px rgba(0,0,0,0.25); }
  h3 { margin: 0 0 8px; color: var(--ink-deep); font-size: 18px; }
  .url { color: var(--muted); font-family: 'Courier New', monospace; font-size: 11px; margin: 0 0 16px; word-break: break-all; }
  .tier-row { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .tier-row label { font-size: 13px; cursor: pointer; }
  .progress { background: var(--paper-warm); border-radius: 8px; padding: 12px; margin-bottom: 12px; font-size: 12px; }
  .progress h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  .step { padding: 3px 0; color: var(--ink); }
  .step strong { color: var(--ink-deep); }
  .error { padding: 10px 12px; background: var(--coral-soft); color: var(--coral-deep); border-radius: 8px; font-size: 12px; margin-bottom: 12px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 8px 16px; border-radius: 100px; font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .muted { color: var(--muted); font-size: 11px; margin: 0; text-align: center; }
  .lifetime-note { color: var(--archive); font-size: 12px; margin: 0 0 10px; font-weight: 500; }
</style>
