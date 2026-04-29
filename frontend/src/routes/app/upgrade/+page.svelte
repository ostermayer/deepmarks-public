<script lang="ts">
  // Lifetime-tier upgrade flow.
  //
  //   1. Show price + pitch
  //   2. User clicks "upgrade" → sign NIP-98 auth → POST /account/lifetime
  //   3. Redirect to BTCPay's hosted checkout (`checkoutLink`)
  //   4. BTCPay sends the settlement webhook → payment-proxy stamps pubkey
  //   5. BTCPay's built-in redirect sends the user to /app/upgrade?done=1
  //   6. Post-redirect we poll /account/lifetime/status until isLifetimeMember=true
  //
  // The webhook is authoritative; the redirect is just user-experience sugar.
  // If the user closes the tab before being redirected, the server-side
  // marker is still stamped when the invoice settles.

  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api/client';
  import { config } from '$lib/config';
  import { canSign, isAuthenticated, session, npub as npubStore } from '$lib/stores/session';
  import { setLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { get } from 'svelte/store';

  let isLifetimeMember = false;
  let paidAt: number | null = null;
  let loading = true;
  let starting = false;
  let error: string | null = null;

  // After BTCPay redirects back with ?done=1 we poll for up to ~30s waiting
  // for the webhook to land. Usually it's stamped within 1-2 seconds of
  // the invoice settling on Lightning.
  $: justPaid = $page.url.searchParams.get('done') === '1';

  onMount(() => {
    void refresh();
    if (justPaid) void pollUntilStamped();
  });

  async function refresh() {
    loading = true;
    try {
      const s = get(session);
      if (!s.pubkey) {
        loading = false;
        return;
      }
      const res = await api.lifetime.status(s.pubkey);
      isLifetimeMember = res.isLifetimeMember;
      paidAt = res.paidAt;
      // Mirror into the shared cache so the Header / feed-row badges flip
      // without waiting for their own independent refetch.
      setLifetimeStatus(s.pubkey, res.isLifetimeMember);
    } catch (e) {
      error = e instanceof Error ? e.message : 'failed to load status';
    } finally {
      loading = false;
    }
  }

  async function pollUntilStamped() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await refresh();
      if (isLifetimeMember) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function startUpgrade() {
    if (!$canSign) {
      // The user is authenticated (pubkey from persisted hint) but the
      // signer couldn't be silently restored — typically because they
      // signed in with an nsec and then reloaded. Send them back to
      // /login with a redirect so they re-enter their key and land
      // right here to complete the upgrade.
      void goto(`/login?redirect=${encodeURIComponent('/app/upgrade')}`);
      return;
    }
    error = null;
    starting = true;
    try {
      const redirect = `${window.location.origin}/app/upgrade?done=1`;
      const { checkoutLink } = await api.lifetime.checkout(redirect);
      // BTCPay's checkout lives at a /i/<id> URL. Full-page nav so the
      // user sees the hosted page; BTCPay handles the QR + payment UX.
      window.location.href = checkoutLink;
    } catch (e) {
      starting = false;
      if (e instanceof ApiError && e.status === 409) {
        isLifetimeMember = true;
      } else {
        error = e instanceof Error ? e.message : 'failed to start checkout';
      }
    }
  }

  function formatDate(unix: number | null): string {
    if (!unix) return '';
    return new Date(unix * 1000).toLocaleDateString();
  }
</script>

<svelte:head><title>upgrade — Deepmarks</title></svelte:head>

<div class="wrap">
  {#if !$isAuthenticated}
    <p class="muted">sign in to upgrade.</p>
  {:else if loading}
    <p class="muted">loading status…</p>
  {:else if isLifetimeMember}
    <div class="card done">
      <h1>lifetime member</h1>
      <p>your pubkey <code>{$npubStore ?? ''}</code> is a lifetime member{paidAt ? ` since ${formatDate(paidAt)}` : ''}.</p>
      <p class="muted">all site-archive charges are covered. thanks for supporting the open web.</p>
    </div>
  {:else if justPaid}
    <div class="card waiting">
      <h1>finalizing your upgrade…</h1>
      <p>BTCPay confirmed your payment. we're waiting for the settlement notification — this usually lands within a few seconds of the Lightning invoice clearing.</p>
      <p class="muted">this page will auto-refresh; safe to close the tab and come back later.</p>
    </div>
  {:else}
    <div class="card offer">
      <h1>lifetime membership</h1>
      <p class="amount">{config.lifetimePriceSats.toLocaleString()} <small>sats</small></p>
      <ul>
        <li>unlimited site archives</li>
        <li>duplicated storage worldwide</li>
        <li>API access for programmatic reads/writes</li>
        <li>no subscription — pay once</li>
      </ul>
      <button class="pixel-btn primary" on:click={startUpgrade} disabled={starting}>
        {starting ? 'opening checkout…' : 'upgrade with lightning'}
      </button>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <p class="muted fine">
        you'll be redirected to BTCPay's hosted checkout. payment confirms via webhook; your pubkey
        is stamped as soon as the invoice settles.
      </p>
    </div>
  {/if}
</div>

<style>
  .wrap {
    max-width: 520px;
    margin: 40px auto;
    padding: 0 24px;
  }
  .card {
    border: 2px solid var(--ink-deep);
    padding: 28px;
    background: var(--paper);
  }
  .card.offer {
    background: var(--coral-soft);
    box-shadow: 3px 3px 0 var(--coral);
  }
  .card.done {
    background: var(--paper);
    box-shadow: 3px 3px 0 var(--archive);
  }
  .card.waiting {
    background: var(--paper-warm);
  }
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink-deep);
    margin: 0 0 6px;
    text-transform: lowercase;
    letter-spacing: -0.3px;
  }
  .amount {
    font-family: 'VT323', 'Courier New', monospace;
    font-size: 42px;
    color: var(--coral-deep);
    margin: 8px 0 18px;
    line-height: 1;
  }
  .amount small {
    font-size: 16px;
    color: var(--muted);
    margin-left: 4px;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0 0 20px;
  }
  ul li {
    padding: 4px 0;
    font-size: 13px;
    color: var(--ink);
  }
  ul li::before {
    content: '▸ ';
    color: var(--coral);
    font-size: 11px;
  }
  .pixel-btn {
    width: 100%;
    margin-top: 4px;
  }
  .pixel-btn[disabled] {
    opacity: 0.6;
    cursor: wait;
  }
  .error {
    color: var(--coral-deep);
    margin: 12px 0 0;
    font-size: 13px;
  }
  .muted {
    color: var(--muted);
    font-size: 13px;
  }
  .fine {
    font-size: 11px;
    margin-top: 16px;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
    word-break: break-all;
  }
</style>
