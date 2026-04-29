<script lang="ts">
  // First-sign-in tier picker. Login routes here when the user hasn't
  // chosen a tier yet (no localStorage flag). Signup also routes through
  // the equivalent step inline before the user ever hits this page.
  //
  // Picking a tier sets the flag so subsequent sign-ins skip straight to
  // /app. The "upgrade to lifetime" affordance lives in /app/settings
  // for users who want to re-evaluate later.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { nip19 } from 'nostr-tools';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { config } from '$lib/config';
  import { isAuthenticated, session } from '$lib/stores/session';
  import { markTierChosen } from '$lib/onboarding';
  import { api } from '$lib/api/client';

  let checkingLifetime = true;

  onMount(async () => {
    // Hard fallback — if the user lands here without a session we can't
    // make a tier decision for them. Bounce to /login.
    if (!session.hint && !$isAuthenticated) {
      void goto('/login');
      return;
    }

    // Already a lifetime member? Skip the picker entirely. A user who
    // upgraded via the browser extension's BTCPay flow (or in any other
    // session) should not be re-asked to pick a plan when they sign in
    // on the web. Mark the tier-chosen flag so they don't keep landing
    // here, then bounce to /app.
    const pubkey = pubkeyFromSession();
    if (pubkey) {
      try {
        const status = await api.lifetime.status(pubkey);
        if (status.isLifetimeMember) {
          markTierChosen();
          void goto('/app');
          return;
        }
      } catch {
        // Network blip — fall through to the picker; the user can still
        // proceed and a re-sign-in next time will retry this check.
      }
    }
    checkingLifetime = false;
  });

  /** Resolve the user's hex pubkey from either the live signer store
   *  (after rehydrate completes) or the cached session hint (npub).
   *  Either is fine — we just need the hex for the lifetime-status API. */
  function pubkeyFromSession(): string | null {
    if ($session.pubkey) return $session.pubkey;
    const npub = session.hint?.npub;
    if (!npub) return null;
    try {
      const decoded = nip19.decode(npub);
      return decoded.type === 'npub' ? (decoded.data as string) : null;
    } catch {
      return null;
    }
  }

  function pickTier(tier: 'free' | 'lifetime') {
    markTierChosen();
    void goto(tier === 'lifetime' ? '/app/upgrade' : '/app');
  }
</script>

<svelte:head><title>Welcome — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>
  {#if checkingLifetime}
    <p class="checking">checking your account…</p>
  {:else}
    <h1>pick a plan</h1>
    <p class="lede">
      free is enough for most people. lifetime is a one-time payment that lets you archive every
      bookmark forever instead of paying per save.
    </p>

    <div class="tier-cards">
      <button type="button" class="tier-card default" on:click={() => pickTier('free')}>
        <strong class="tier-card-h">free</strong>
        <p class="tier-card-amt">{config.archivePriceSats} sats per archived URL</p>
        <p class="tier-card-blurb">
          unlimited bookmarks, public + private. archive forever costs sats only when you actually
          archive a URL.
        </p>
        <span class="tier-card-cta">go to app →</span>
      </button>
      <button type="button" class="tier-card" on:click={() => pickTier('lifetime')}>
        <strong class="tier-card-h">lifetime</strong>
        <p class="tier-card-amt">{config.lifetimePriceSats.toLocaleString()} sats once</p>
        <p class="tier-card-blurb">
          archive every bookmark forever, no per-URL fee. one-time payment. you can also pay later
          from settings if you want to think about it.
        </p>
        <span class="tier-card-cta">pay + go →</span>
      </button>
    </div>
  {/if}
</div>

<Footer />

<style>
  .page { max-width: 540px; margin: 0 auto; padding: 60px 24px 40px; position: relative; }
  .back {
    position: absolute; top: 20px; left: 24px;
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted) !important; font-size: 12px; text-decoration: none;
  }
  .back:hover { color: var(--coral) !important; text-decoration: none; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); margin: 0 0 8px; letter-spacing: -0.4px; }
  .lede { color: var(--ink); margin: 0 0 20px; font-size: 14px; line-height: 1.55; }
  .tier-cards { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .tier-card {
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 16px 18px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 120ms, transform 80ms;
  }
  .tier-card:hover { border-color: var(--coral); }
  .tier-card:active { transform: translateY(1px); }
  .tier-card.default { border-color: var(--coral); background: var(--coral-soft); }
  .tier-card-h { display: block; font-family: 'Space Grotesk', Inter, sans-serif; font-size: 20px; color: var(--ink-deep); }
  .tier-card-amt { margin: 4px 0 8px; color: var(--coral-deep); font-size: 13px; font-weight: 600; }
  .tier-card-blurb { margin: 0 0 10px; font-size: 12.5px; color: var(--ink); line-height: 1.55; }
  .tier-card-cta { color: var(--coral-deep); font-size: 12px; font-weight: 600; }
  .checking { color: var(--muted); font-size: 13px; padding: 24px 0; }
</style>
