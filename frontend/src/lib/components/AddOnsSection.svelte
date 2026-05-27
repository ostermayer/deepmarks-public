<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, ApiError, type MediaArchiveAddonStatus } from '$lib/api/client';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { config } from '$lib/config';
  import { mediaArchiveCounts, queueEligibleMediaArchives } from '$lib/media-archive';
  import { isNativeShell } from '$lib/native/runtime';
  import { isLifetimeMemberOnce } from '$lib/nostr/lifetime-status';
  import { myArchiveRecords } from '$lib/stores/my-archives';
  import { ownBookmarks } from '$lib/stores/own-bookmarks';
  import { session } from '$lib/stores/session';
  import SettingsSection from './SettingsSection.svelte';

  const MEDIA_ARCHIVE_SATS = 150_000;

  let nativeShell = isNativeShell();
  let loading = false;
  let starting = false;
  let queueing = false;
  let error = '';
  let notice = '';
  let status: MediaArchiveAddonStatus | null = null;
  let isLifetime = false;
  let activeCheckoutLink = '';
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;

  $: counts = mediaArchiveCounts($ownBookmarks, $myArchiveRecords);
  $: purchased = !!status?.purchased;
  $: canPurchase = !IS_APPLE_BUILD && isLifetime && !purchased;
  $: if (purchased && counts.eligible > counts.archived + counts.queued) scheduleBacklogQueue();

  onMount(() => {
    nativeShell = isNativeShell();
    void refreshStatus();
    pollTimer = setInterval(() => void refreshStatus({ quiet: true }), 5_000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (queueTimer) clearTimeout(queueTimer);
  });

  async function refreshStatus(opts: { quiet?: boolean } = {}): Promise<void> {
    if (!$session.pubkey) return;
    if (!opts.quiet) loading = true;
    try {
      const [lifetime, remoteStatus] = await Promise.all([
        isLifetimeMemberOnce($session.pubkey),
        api.mediaArchive.status(),
      ]);
      isLifetime = lifetime;
      status = remoteStatus;
      if (remoteStatus.purchased) activeCheckoutLink = '';
      error = '';
    } catch (e) {
      if (!opts.quiet) error = (e as Error).message ?? 'could not load add-on status';
    } finally {
      loading = false;
    }
  }

  async function startCheckout(): Promise<void> {
    if (!canPurchase || starting) return;
    error = '';
    notice = '';
    starting = true;
    try {
      const redirectUrl = typeof window !== 'undefined'
        ? `${window.location.origin}/app/settings`
        : undefined;
      const invoice = await api.mediaArchive.checkout(redirectUrl);
      activeCheckoutLink = invoice.checkoutLink;
      if (!nativeShell) {
        window.location.href = invoice.checkoutLink;
        return;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        notice = 'media archive add-on already active';
        await refreshStatus({ quiet: true });
      } else if (e instanceof ApiError && e.status === 402) {
        error = 'lifetime membership is required before adding media archives';
      } else {
        error = (e as Error).message ?? 'failed to open checkout';
      }
    } finally {
      starting = false;
    }
  }

  function scheduleBacklogQueue(): void {
    if (queueTimer || queueing || !$session.pubkey) return;
    queueTimer = setTimeout(() => {
      queueTimer = undefined;
      void queueBacklog();
    }, 500);
  }

  async function queueBacklog(): Promise<void> {
    if (!purchased || queueing) return;
    queueing = true;
    try {
      const result = await queueEligibleMediaArchives($ownBookmarks, $myArchiveRecords);
      if (result.queued > 0) {
        notice = `${result.queued} media archive${result.queued === 1 ? '' : 's'} queued`;
      }
    } catch {
      // Automatic backlog queueing is best-effort; the next settings
      // visit or save can retry without blocking normal settings use.
    } finally {
      queueing = false;
    }
  }
</script>

<SettingsSection title="add-ons">
  <article class="addon">
    <header>
      <div>
        <h3>archive media</h3>
        <p class="addon-desc">
          One-time add-on for automatic private archives of primary video or audio
          from bookmarked pages, including podcast files and supported video sites.
          Media archives are encrypted and only listed for the npub that saved the bookmark.
        </p>
      </div>
      {#if purchased}
        <div class="addon-state active-state" aria-label="media archive add-on active">
          <strong>active</strong>
          <span>one-time add-on</span>
        </div>
      {:else}
        <div class="addon-state price">
          <strong>{MEDIA_ARCHIVE_SATS.toLocaleString()}</strong>
          <span>sats one-time</span>
        </div>
      {/if}
    </header>

    {#if loading}
      <p class="status">checking add-on status...</p>
    {:else if purchased}
      <div class="progress">
        <strong>{counts.archived}/{counts.eligible}</strong>
        <span>potential media bookmarks archived</span>
      </div>
      {#if counts.queued > 0}
        <p class="status">{counts.queued} media archive{counts.queued === 1 ? '' : 's'} queued or processing.</p>
      {:else if counts.eligible === 0}
        <p class="status">bookmark a page with primary audio or video and Deepmarks will queue the private media archive automatically.</p>
      {/if}
    {:else if IS_APPLE_BUILD}
      <p class="status">
        Media archiving is an optional lifetime add-on. iOS can use it after it is enabled
        for this npub outside the App Store build.
      </p>
    {:else if !isLifetime}
      <p class="status">Lifetime membership is required before purchasing the media archive add-on.</p>
      <a class="cta-link" href="/app/upgrade">upgrade to lifetime</a>
    {:else}
      <button type="button" class="cta" on:click={() => void startCheckout()} disabled={starting}>
        {starting ? 'opening checkout...' : 'purchase add-on'}
      </button>
    {/if}

    {#if activeCheckoutLink && nativeShell}
      <div class="checkout-frame-wrap">
        <iframe class="checkout-frame" title="BTCPay media archive checkout" src={activeCheckoutLink}></iframe>
      </div>
      <div class="checkout-actions">
        <button type="button" class="ghost" on:click={() => void refreshStatus()}>check status</button>
      </div>
    {/if}
    {#if notice}<p class="status">{notice}</p>{/if}
    {#if error}<p class="error">{error}</p>{/if}
  </article>
</SettingsSection>

<style>
  .addon {
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 16px;
    background: var(--surface);
  }
  .addon header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 14px;
  }
  .addon h3 { margin: 0 0 4px; font-size: 16px; color: var(--ink-deep); font-weight: 600; }
  .addon-desc { color: var(--ink); font-size: 13px; line-height: 1.5; margin: 0; }
  .addon-state { text-align: right; white-space: nowrap; }
  .addon-state strong { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
  .addon-state span { font-size: 11px; color: var(--muted); }
  .price strong { color: var(--coral-deep); }
  .active-state {
    padding: 4px 10px 6px;
    border: 1px solid color-mix(in srgb, var(--archive) 40%, var(--rule));
    border-radius: 999px;
    background: color-mix(in srgb, var(--archive) 12%, var(--surface));
  }
  .active-state strong {
    color: var(--archive);
    font-size: 13px;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .progress {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--rule);
    border-radius: 999px;
    color: var(--ink-deep);
    background: var(--paper);
  }
  .progress strong {
    color: var(--archive);
    font-variant-numeric: tabular-nums;
  }
  .progress span { color: var(--ink); font-size: 13px; }
  .cta,
  .cta-link {
    display: inline-block;
    background: var(--coral);
    color: var(--on-coral) !important;
    border: 0;
    padding: 8px 16px;
    border-radius: 100px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
  }
  .cta:hover,
  .cta-link:hover { background: var(--coral-deep); text-decoration: none; }
  .cta:disabled { opacity: 0.55; cursor: progress; }
  .checkout-frame-wrap {
    margin: 14px 0 10px;
    border: 1px solid var(--rule);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .checkout-frame {
    display: block;
    width: 100%;
    height: min(70vh, 620px);
    min-height: 480px;
    border: 0;
    background: var(--surface);
  }
  .checkout-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .ghost {
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink-deep);
    font: inherit;
    font-size: 13px;
    padding: 7px 14px;
  }
  .status { color: var(--ink); font-size: 13px; line-height: 1.5; margin: 10px 0 0; }
  .error { color: var(--coral-deep); font-size: 13px; margin: 10px 0 0; }
  @media (max-width: 560px) {
    .addon header { flex-direction: column; }
    .addon-state { text-align: left; }
  }
</style>
