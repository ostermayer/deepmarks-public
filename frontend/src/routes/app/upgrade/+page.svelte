<script lang="ts">
  // Lifetime-tier upgrade flow.
  //
  //   1. Show price + pitch
  //   2. User clicks "upgrade" → sign NIP-98 auth → POST /account/lifetime
  //   3. Native shells show BTCPay's hosted checkout inline; web redirects
  //      to the hosted checkout (`checkoutLink`)
  //   4. BTCPay sends the settlement webhook → payment-proxy stamps pubkey
  //   5. BTCPay shows a paid-checkout return button back to /app/bookmarks
  //   6. Legacy /app/upgrade?done=1 returns still poll status until stamped
  //
  // The webhook is authoritative; the redirect is just user-experience sugar.
  // If the user closes the tab before being redirected, the server-side
  // marker is still stamped when the invoice settles.

  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api/client';
  import { config } from '$lib/config';
  import { canSign, isAuthenticated, session, npub as npubStore } from '$lib/stores/session';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { setLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { mergeSyncedAccountSettings, userSettings } from '$lib/stores/user-settings';
  import { isNativeShell } from '$lib/native/runtime';
  import { get } from 'svelte/store';

  const PENDING_CHECKOUT_KEY = 'deepmarks-lifetime-checkout';

  interface PendingLifetimeCheckout {
    invoiceId: string;
    checkoutLink: string;
    createdAt: number;
  }

  // Apple build never serves this route — bounce straight to /app/bookmarks.
  // The whole upgrade flow is stripped from that bundle by minification
  // (build-flags is a literal-true constant), but the route handler
  // still has to handle the navigation gracefully if a stale link
  // somehow points here. Runs synchronously in onMount so the user
  // sees the bookmark feed instead of a half-loaded payment screen.
  onMount(() => {
    if (IS_APPLE_BUILD) {
      void goto('/app/bookmarks', { replaceState: true });
      return;
    }
    nativeShell = isNativeShell();
    const pending = loadPendingCheckout();
    if (pending) {
      invoiceId = pending.invoiceId;
      checkoutLink = pending.checkoutLink;
      beginStatusPolling();
    }
  });

  let isLifetimeMember = false;
  let paidAt: number | null = null;
  let loading = true;
  let starting = false;
  let error: string | null = null;
  let archiveDefaultSynced = false;
  let lifetimeStatusLoaded = false;
  let nativeShell = isNativeShell();
  let checkoutLink = '';
  let invoiceId = '';
  let finalizing = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Older checkouts may still return with ?done=1. Poll for up to ~30s
  // waiting for the webhook to land. Usually it's stamped within 1-2
  // seconds of the invoice settling on Lightning.
  $: justPaid = $page.url.searchParams.get('done') === '1';

  onMount(() => {
    void refresh();
    if (justPaid) void pollUntilStamped();
  });

  onDestroy(() => {
    stopStatusPolling();
  });

  async function refresh(opts: { silent?: boolean } = {}) {
    if (!opts.silent) loading = true;
    try {
      const s = get(session);
      if (!s.pubkey) {
        if (!opts.silent) loading = false;
        return;
      }
      const res = await api.lifetime.status(s.pubkey);
      const transitionedToLifetime = lifetimeStatusLoaded && !isLifetimeMember && res.isLifetimeMember;
      isLifetimeMember = res.isLifetimeMember;
      lifetimeStatusLoaded = true;
      paidAt = res.paidAt;
      // Mirror into the shared cache so the Header / feed-row badges flip
      // without waiting for their own independent refetch.
      setLifetimeStatus(s.pubkey, res.isLifetimeMember);
      if (res.isLifetimeMember && (justPaid || transitionedToLifetime)) {
        void enableArchiveDefault();
      }
      if (res.isLifetimeMember) {
        clearPendingCheckout();
        stopStatusPolling();
        if (nativeShell && checkoutLink) {
          void goto('/app/bookmarks?upgraded=1', { replaceState: true });
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'failed to load status';
    } finally {
      if (!opts.silent) loading = false;
    }
  }

  async function enableArchiveDefault() {
    if (archiveDefaultSynced) return;
    archiveDefaultSynced = true;
    try {
      const remote = await api.account.getSettings();
      const saved = await api.account.putSettings({
        relays: remote.relays,
        defaultTags: remote.defaultTags,
        defaultVisibility: remote.defaultVisibility,
        archiveAllByDefault: true,
        archiveDefaultManualOverride: false,
        backupBlossomServers: remote.backupBlossomServers,
        theme: remote.theme,
      });
      userSettings.update((current) => mergeSyncedAccountSettings(current, saved));
    } catch {
      archiveDefaultSynced = false;
    }
  }

  async function pollUntilStamped() {
    finalizing = true;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await refresh();
      if (isLifetimeMember) {
        finalizing = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    finalizing = false;
  }

  function beginStatusPolling() {
    if (pollTimer) return;
    finalizing = true;
    pollTimer = setInterval(() => {
      void refresh({ silent: true });
    }, 2500);
    void refresh({ silent: true });
  }

  function stopStatusPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    finalizing = false;
  }

  function checkoutReturnUrl(): string {
    if (nativeShell) return 'deepmarks://upgrade?done=1';
    return `${config.webBase}/app/bookmarks?upgraded=1`;
  }

  function loadPendingCheckout(): PendingLifetimeCheckout | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_CHECKOUT_KEY) ?? 'null') as PendingLifetimeCheckout | null;
      if (!parsed?.invoiceId || !parsed.checkoutLink) return null;
      if (Date.now() - parsed.createdAt > 24 * 60 * 60 * 1000) {
        clearPendingCheckout();
        return null;
      }
      return parsed;
    } catch {
      clearPendingCheckout();
      return null;
    }
  }

  function stashPendingCheckout(pending: PendingLifetimeCheckout): void {
    try {
      localStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(pending));
    } catch {
      // Current page state still polls while the app stays alive.
    }
  }

  function clearPendingCheckout(): void {
    try {
      localStorage.removeItem(PENDING_CHECKOUT_KEY);
    } catch {
      // Non-fatal.
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
      const checkout = await api.lifetime.checkout(checkoutReturnUrl());
      invoiceId = checkout.invoiceId;
      checkoutLink = checkout.checkoutLink;
      stashPendingCheckout({ invoiceId, checkoutLink, createdAt: Date.now() });
      beginStatusPolling();
      if (nativeShell) {
        starting = false;
        return;
      }
      // BTCPay's checkout lives at a /i/<id> URL. Full-page nav so the
      // user sees the hosted page; BTCPay handles the QR + payment UX.
      window.location.href = checkout.checkoutLink;
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

  function checkNow() {
    void refresh();
  }
</script>

<svelte:head><title>upgrade — Deepmarks</title></svelte:head>

<!-- Apple build never renders the upgrade UI even during the onMount
     redirect frame. Wrapping the template in this guard means the
     compiled bundle for iOS won't carry the price markup at all
     (Vite inlines import.meta.env.VITE_APPLE_BUILD as a literal at
     build time, so the unreachable branch tree-shakes). -->
{#if !IS_APPLE_BUILD}
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
      <a class="return-link" href="/app/bookmarks">go to bookmarks</a>
    </div>
  {:else if justPaid}
    <div class="card waiting">
      <h1>finalizing your upgrade…</h1>
      <p>BTCPay confirmed your payment. we're waiting for the settlement notification — this usually lands within a few seconds of the Lightning invoice clearing.</p>
      <p class="muted">this page will auto-refresh; safe to close the tab and come back later.</p>
      <a class="return-link" href="/app/bookmarks">go to bookmarks</a>
    </div>
  {:else if checkoutLink}
    <div class="card checkout-card">
      <h1>complete checkout</h1>
      <p class="muted">pay the BTCPay invoice below. Deepmarks will detect settlement and return you to bookmarks automatically.</p>
      <div class="checkout-frame-wrap">
        <iframe
          class="checkout-frame"
          title="BTCPay checkout"
          src={checkoutLink}
        ></iframe>
      </div>
      <div class="checkout-actions">
        <a class="return-link" href={checkoutLink} target="_blank" rel="noreferrer">open checkout</a>
        <button type="button" class="ghost" on:click={checkNow} disabled={finalizing}>
          {finalizing ? 'checking…' : 'check status'}
        </button>
      </div>
      {#if invoiceId}
        <p class="muted fine">invoice {invoiceId}</p>
      {/if}
    </div>
  {:else}
    <div class="card offer">
      <h1>lifetime membership</h1>
      <p class="amount">{config.lifetimePriceSats.toLocaleString('en-US')} <small>sats</small></p>
      <ul>
        <li>unlimited site archives</li>
        <li>duplicated storage worldwide</li>
        <li>API access for programmatic reads/writes</li>
        <li>no subscription — pay once</li>
      </ul>
      <button class="pixel-btn primary" on:click={startUpgrade} disabled={starting}>
        {starting ? 'opening checkout…' : 'upgrade'}
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
{/if}

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
  .card.checkout-card {
    width: min(100%, 640px);
    margin-left: auto;
    margin-right: auto;
    background: var(--paper);
    box-shadow: 3px 3px 0 var(--ink-deep);
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
  .return-link {
    display: inline-flex;
    margin-top: 10px;
    color: var(--coral-deep);
    font-size: 13px;
    font-weight: 700;
  }
  .checkout-frame-wrap {
    margin: 16px 0;
    border: 1px solid var(--rule);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .checkout-frame {
    display: block;
    width: 100%;
    height: min(72vh, 680px);
    min-height: 520px;
    border: 0;
    background: var(--surface);
  }
  .checkout-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .ghost {
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink-deep);
    font: inherit;
    font-size: 13px;
    padding: 7px 14px;
  }
  .ghost:disabled {
    opacity: 0.6;
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
