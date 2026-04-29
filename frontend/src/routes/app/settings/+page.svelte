<script lang="ts">
  import { goto } from '$app/navigation';
  import { theme } from '$lib/stores/theme';
  import { session, npub } from '$lib/stores/session';
  import { userSettings } from '$lib/stores/user-settings';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { getRelayList } from '$lib/nostr/relay-list';
  import { config } from '$lib/config';
  import ApiKeysSection from '$lib/components/ApiKeysSection.svelte';
  import UsernameSection from '$lib/components/UsernameSection.svelte';
  import DeleteAccountSection from '$lib/components/DeleteAccountSection.svelte';
  import LightningAddressSection from '$lib/components/LightningAddressSection.svelte';
  import ProfilePictureSection from '$lib/components/ProfilePictureSection.svelte';
  import MuteListSection from '$lib/components/MuteListSection.svelte';
  import PrivateKeySection from '$lib/components/PrivateKeySection.svelte';

  $: lifetimeStatus = $session.pubkey ? getLifetimeStatus($session.pubkey) : null;
  $: isLifetime = !!(lifetimeStatus && $lifetimeStatus);

  // NIP-65 relay list (kind:10002) for the signed-in user. Displays the
  // relay preferences Deepmarks picked up via NDK's outbox model; stays
  // null if the user has never published one, in which case we fall
  // back to showing the default set.
  $: relayListStore = $session.pubkey ? getRelayList($session.pubkey) : null;
  $: userRelays = relayListStore ? $relayListStore : null;

  let newRelay = '';
  // Profile name + bio + nip05 are intentionally NOT managed here —
  // purpose-built nostr clients (Damus, Primal, Amethyst, …) already
  // own that UX. We do surface:
  //   • lightning address — drives the zap split
  //   • profile picture — the extension links here when the user taps
  //     their default avatar; sending them to a separate client just
  //     to set an avatar is bad UX
</script>

<svelte:head><title>settings — Deepmarks</title></svelte:head>

<div class="page">
  <h1>settings</h1>

  <section>
    <h2>identity</h2>
    <div class="row">
      <span class="label">npub</span>
      <code>{$npub ?? '—'}</code>
    </div>
    <div class="row">
      <span class="label">signer</span>
      <span>{$session.signer?.kind ?? 'not connected'}</span>
    </div>
  </section>

  <section>
    <h2>plan</h2>
    {#if isLifetime}
      <p class="muted">lifetime ✓ — every bookmark archives forever, no per-URL fee.</p>
    {:else}
      <p class="muted">
        free — you pay {config.archivePriceSats} sats per archived URL. lifetime is a one-time
        {config.lifetimePriceSats.toLocaleString()} sats and archives every bookmark forever.
      </p>
      <a href="/app/upgrade" class="upgrade-cta">upgrade to lifetime →</a>
    {/if}
  </section>

  <ProfilePictureSection />

  <LightningAddressSection />

  <PrivateKeySection />

  <UsernameSection {isLifetime} />

  <section>
    <h2>theme</h2>
    <div class="theme-row">
      <button class:active={$theme === 'light'} on:click={() => theme.set('light')}>light</button>
      <button class:active={$theme === 'dark'} on:click={() => theme.set('dark')}>dark</button>
      <button class:active={$theme === 'auto'} on:click={() => theme.set('auto')}>follow system</button>
    </div>
  </section>

  <section>
    <h2>relays</h2>
    {#if userRelays && userRelays.relays.length > 0}
      <p class="muted">
        your NIP-65 list, signed <code>{new Date(userRelays.at * 1000).toLocaleDateString()}</code>.
        deepmarks publishes + reads via these.
      </p>
      <ul class="relay-list">
        {#each userRelays.relays as r (r.url)}
          <li>
            <code>{r.url}</code>
            {#if r.mode !== 'both'}<span class="badge mode-{r.mode}">{r.mode}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else if relayListStore && userRelays === null}
      <p class="muted">looking for your NIP-65 list on connected relays…</p>
      <ul class="relay-list">
        <li><code>{config.deepmarksRelay}</code> <span class="badge">deepmarks</span></li>
        {#each config.defaultRelays as r}
          <li><code>{r}</code></li>
        {/each}
      </ul>
    {:else}
      <p class="muted">default set — sign in to load your NIP-65 list.</p>
      <ul class="relay-list">
        <li><code>{config.deepmarksRelay}</code> <span class="badge">deepmarks</span></li>
        {#each config.defaultRelays as r}
          <li><code>{r}</code></li>
        {/each}
      </ul>
    {/if}
    <div class="add-relay">
      <input type="text" placeholder="wss://your-relay.example" bind:value={newRelay} />
      <button class="primary" type="button" disabled>add (Phase 5)</button>
    </div>
  </section>

  <section>
    <h2>site archive storage</h2>
    <p class="muted">
      Paid site archives are mirrored to 4 Blossom operators by default — Deepmarks, Primal,
      Satellite CDN, hzrd149. Customize in Phase 7.
    </p>
    <label class="toggle">
      <input
        type="checkbox"
        checked={$userSettings.archiveAllByDefault}
        on:change={(e) =>
          userSettings.update((s) => ({ ...s, archiveAllByDefault: e.currentTarget.checked }))}
      />
      <span>
        archive every bookmark by default
        {#if !isLifetime}
          <small>— charges {config.archivePriceSats} sats per bookmark unless you upgrade</small>
        {:else}
          <small>— free for lifetime members</small>
        {/if}
      </span>
    </label>
  </section>

  <MuteListSection />

  <ApiKeysSection />

  <section>
    <h2>sign out</h2>
    <p class="muted">sign out of this browser — your nostr data stays on the relays.</p>
    <button
      type="button"
      class="ghost"
      on:click={() => { session.logout(); void goto('/'); }}
    >sign out</button>
  </section>

  <DeleteAccountSection />
</div>

<style>
  .page { max-width: 720px; margin: 0 auto; padding: 36px 24px 60px; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); letter-spacing: -0.4px; margin: 0 0 8px; }
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
  .row { display: flex; gap: 16px; padding: 6px 0; font-size: 13px; color: var(--ink-deep); }
  .row .label { color: var(--ink); width: 80px; font-weight: 500; }
  code { font-family: 'Courier New', monospace; font-size: 11px; color: var(--ink-deep); word-break: break-all; }
  .theme-row { display: flex; gap: 8px; }
  .theme-row button { background: var(--surface); border: 1px solid var(--rule); color: var(--ink); padding: 6px 14px; border-radius: 100px; cursor: pointer; font-size: 12px; }
  .theme-row button.active { border-color: var(--coral); color: var(--coral); }
  .muted { color: var(--ink); font-size: 13px; line-height: 1.55; }
  .upgrade-cta {
    display: inline-block; margin-top: 8px;
    background: var(--coral); color: var(--on-coral) !important;
    padding: 8px 16px; border-radius: 100px;
    font-size: 13px; font-weight: 500; text-decoration: none;
  }
  .upgrade-cta:hover { background: var(--coral-deep); text-decoration: none; }
  .relay-list { list-style: none; padding: 0; margin: 0 0 12px; }
  .relay-list li { padding: 6px 0; border-bottom: 1px dashed var(--rule); display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-deep); }
  .badge { background: var(--coral-soft); color: var(--coral-deep); padding: 1px 8px; border-radius: 10px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; }
  .badge.mode-read { background: var(--paper-warm); color: var(--ink-deep); }
  .badge.mode-write { background: var(--paper-warm); color: var(--ink-deep); }
  .add-relay { display: flex; gap: 8px; }
  .add-relay input { flex: 1; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink-deep); font-family: 'Courier New', monospace; font-size: 12px; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-size: 13px; }
  .ghost:hover { border-color: var(--coral); color: var(--coral-deep); }
  .toggle { display: flex; align-items: flex-start; gap: 10px; margin-top: 12px; cursor: pointer; font-size: 13px; color: var(--ink-deep); }
  .toggle input { margin-top: 3px; flex-shrink: 0; }
  .toggle small { display: block; color: var(--ink); font-size: 11px; margin-top: 2px; }
</style>
