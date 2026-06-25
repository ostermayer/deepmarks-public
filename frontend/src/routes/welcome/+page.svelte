<script lang="ts">
  // First-sign-in tier picker. Login routes here when the user hasn't
  // chosen a tier yet (no localStorage flag). Signup also routes through
  // the equivalent step inline before the user ever hits this page.
  //
  // Picking a tier sets the flag so subsequent sign-ins skip straight to
  // /app/bookmarks. The "upgrade to lifetime" affordance lives in /app/settings
  // for users who want to re-evaluate later.

  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { nip19 } from 'nostr-tools';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { config } from '$lib/config';
  import { isAuthenticated, session } from '$lib/stores/session';
  import { markTierChosen } from '$lib/onboarding';
  import { isLifetimeMemberOnce } from '$lib/nostr/lifetime-status';
  import { nativePlatform } from '$lib/native/runtime';

  let checkingLifetime = true;
  let hideSignupPlans = IS_APPLE_BUILD;

  onMount(async () => {
    // Hard fallback — if the user lands here without a session we can't
    // make a tier decision for them. Bounce to /login.
    if (!session.hint && !$isAuthenticated) {
      void goto('/login');
      return;
    }

    hideSignupPlans = IS_APPLE_BUILD || nativePlatform() === 'ios';
    if (hideSignupPlans) {
      markTierChosen();
      void goto('/app/bookmarks', { replaceState: true });
      return;
    }

    // Already a lifetime member? Skip the picker entirely. A user who
    // upgraded in any other session should not be re-asked to pick a
    // plan when they sign in on a new web or Android install.
    const pubkey = pubkeyFromSession();
    if (pubkey) {
      if (await isLifetimeMemberOnce(pubkey)) {
        markTierChosen();
        void goto('/app/bookmarks', { replaceState: true });
        return;
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
    void goto(tier === 'lifetime' && !hideSignupPlans ? '/app/upgrade' : '/app/bookmarks');
  }
</script>

<svelte:head><title>Welcome — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>
  {#if IS_APPLE_BUILD}
    <p class="checking">checking your account…</p>
  {:else if checkingLifetime || hideSignupPlans}
    <p class="checking">checking your account…</p>
  {:else}
    <h1>choose how you want to start</h1>
    <p class="lede">
      Bookmarking is free. Lifetime adds page archiving when you already
      know you want saved pages preserved.
    </p>

    <div class="tier-cards">
      <button type="button" class="tier-card default" on:click={() => pickTier('free')}>
        <strong class="tier-card-h">free</strong>
        <p class="tier-card-amt">0 sats</p>
        <p class="tier-card-blurb">
          unlimited bookmarks, public + private{IS_APPLE_BUILD ? '.' : '. upgrade later if you want page archives.'}
        </p>
        <span class="tier-card-cta">start saving →</span>
      </button>
      {#if !IS_APPLE_BUILD}
      <button type="button" class="tier-card" on:click={() => pickTier('lifetime')}>
        <strong class="tier-card-h">lifetime</strong>
        <p class="tier-card-amt">{config.lifetimePriceSats.toLocaleString('en-US')} sats once</p>
        <p class="tier-card-blurb">
          archive saved pages, use API keys, and claim a short handle. you can also pay later
          from settings if you want to think about it.
        </p>
        <span class="tier-card-cta">upgrade →</span>
      </button>
      {/if}
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
