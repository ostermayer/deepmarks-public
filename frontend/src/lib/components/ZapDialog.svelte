<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import {
    lightningUriForInvoice,
    ManualPaymentRequired,
    payInvoices,
    planZap,
    type ZapInvoice
  } from '$lib/nostr/zap';
  import {
    createZapInvoices,
    invoiceKey,
    invoiceQrCodes,
    manualFallbackInvoices,
    manualNoticeForError,
  } from '$lib/nostr/zap-flow';
  import { watchZapReceipts, type ZapReceiptWatcher } from '$lib/nostr/zap-receipts';
  import { getProfile, profileLightningAddress, resolveProfile } from '$lib/nostr/profiles';
  import { currentSession } from '$lib/stores/session';

  export let bookmark: ParsedBookmark;
  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void; paid: { preimages: string[]; invoices: ZapInvoice[] } }>();

  let amount = 21;
  let comment = '';
  let working = false;
  let workingAction: '' | 'zap' | 'invoice' = '';
  let error = '';
  let manualNotice = '';
  let manualInvoices: ZapInvoice[] = [];
  let manualQrCodes: string[] = [];
  let manualIndex = 0;
  let copyState = '';
  let manualReceiptWatcher: ZapReceiptWatcher | null = null;
  let manualReceiptStatus = '';
  let manualPaidInvoices = new Set<string>();
  let resolvedCuratorLightning: string | null = null;
  let lastCurator = '';

  // Curator's Lightning address comes from their kind:0 profile
  // (lud16/lightning_address or lud06).
  // Reactive store: renders the initial plan against a null value, then
  // re-renders once NDK resolves the profile. Missing values route the
  // full zap to Deepmarks rather than creating a dead zap flow.
  $: if (bookmark.curator !== lastCurator) {
    lastCurator = bookmark.curator;
    resolvedCuratorLightning = null;
  }
  $: curatorProfile = getProfile(bookmark.curator);
  $: if (profileLightningAddress($curatorProfile)) resolvedCuratorLightning = profileLightningAddress($curatorProfile);
  $: curatorLightning = resolvedCuratorLightning ?? profileLightningAddress($curatorProfile);

  $: plan = planZap(bookmark, amount, curatorLightning);
  $: canZap = plan.recipients.length > 0 && amount >= 1;

  // Drives the honest-copy banner below the recipient row.
  $: curatorUnroutable = !curatorLightning;

  async function pay() {
    error = '';
    manualInvoices = [];
    manualQrCodes = [];
    manualIndex = 0;
    copyState = '';
    manualNotice = '';
    stopManualReceiptWatch();
    working = true;
    workingAction = 'zap';
    let invoices: ZapInvoice[] = [];
    try {
      await refreshCuratorLightning();
      invoices = await buildInvoices();
      const preimages = await payInvoices(invoices);
      dispatch('paid', { preimages, invoices });
      open = false;
    } catch (e) {
      const fallbackInvoices = manualFallbackInvoices(e, invoices);
      if (fallbackInvoices) {
        if (!(e instanceof ManualPaymentRequired)) error = (e as Error).message;
        await showManualPayment(fallbackInvoices, manualNoticeForError(e));
      } else {
        error = (e as Error).message;
      }
    } finally {
      working = false;
      workingAction = '';
    }
  }

  async function showInvoicePayment() {
    error = '';
    manualInvoices = [];
    manualQrCodes = [];
    manualIndex = 0;
    copyState = '';
    manualNotice = '';
    stopManualReceiptWatch();
    working = true;
    workingAction = 'invoice';
    try {
      await refreshCuratorLightning();
      await showManualPayment(await buildInvoices());
    } catch (e) {
      error = (e as Error).message;
    } finally {
      working = false;
      workingAction = '';
    }
  }

  async function buildInvoices(): Promise<ZapInvoice[]> {
    const session = currentSession();
    return createZapInvoices({ plan, bookmark, zapperPubkey: session.pubkey, comment });
  }

  async function refreshCuratorLightning() {
    if (curatorLightning) return;
    const profile = await resolveProfile(bookmark.curator);
    const lightning = profileLightningAddress(profile);
    if (lightning) resolvedCuratorLightning = lightning;
  }

  async function showManualPayment(invoices: ZapInvoice[], notice = '') {
    manualInvoices = invoices;
    manualIndex = 0;
    copyState = '';
    manualNotice = notice || invoices.find((inv) => inv.zapReceiptWarning)?.zapReceiptWarning || '';
    manualPaidInvoices = new Set();
    manualQrCodes = await invoiceQrCodes(invoices);
    startManualReceiptWatch(invoices);
  }

  async function copyInvoice(invoice: string) {
    try {
      await navigator.clipboard.writeText(invoice);
      copyState = 'copied';
      setTimeout(() => (copyState = ''), 1500);
    } catch {
      copyState = 'copy failed';
    }
  }

  function resetManualPayment() {
    manualInvoices = [];
    manualQrCodes = [];
    manualIndex = 0;
    copyState = '';
    manualNotice = '';
    stopManualReceiptWatch();
    error = '';
  }

  function isManualInvoicePaid(invoice: string): boolean {
    return manualPaidInvoices.has(invoiceKey(invoice));
  }

  function stopManualReceiptWatch() {
    manualReceiptWatcher?.stop();
    manualReceiptWatcher = null;
    manualReceiptStatus = '';
    manualPaidInvoices = new Set();
  }

  function startManualReceiptWatch(invoices: ZapInvoice[]) {
    stopManualReceiptWatch();
    manualReceiptWatcher = watchZapReceipts(invoices, {
      onStatus: (status) => {
        manualReceiptStatus = status;
      },
      onPaid: (nextPaid) => {
        manualPaidInvoices = nextPaid;
        const nextUnpaidIndex = manualInvoices.findIndex((inv) => !nextPaid.has(invoiceKey(inv.invoice)));
        if (nextUnpaidIndex >= 0) manualIndex = nextUnpaidIndex;
      },
      onAllPaid: () => {
        dispatch('paid', { preimages: [], invoices: manualInvoices });
        open = false;
      },
    });
  }

  $: manualPaidCount = manualPaidInvoices.size;
  $: activeManualInvoice = manualInvoices[manualIndex] ?? null;
  $: activeManualQr = manualQrCodes[manualIndex] ?? '';
  $: if (!open) stopManualReceiptWatch();

  onDestroy(() => stopManualReceiptWatch());
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

      <div class="recipient">
        <h4>recipient</h4>
        {#if plan.recipients.length}
          {#each plan.recipients as r}
            <div class="row">
              <span>{r.label}</span>
              <strong>{(r.millisats / 1000).toLocaleString()} sats</strong>
            </div>
          {/each}
        {:else}
          <div class="row">
            <span>enter a positive zap amount</span>
            <strong>0 sats</strong>
          </div>
        {/if}
      </div>

      {#if curatorUnroutable}
        <p class="fallback-note">
          the curator hasn't set a Lightning address on their Nostr profile, so this zap goes to Deepmarks.
        </p>
      {/if}

      {#if error}<div class="error">{error}</div>{/if}

      {#if activeManualInvoice}
        <div class="manual">
          <div class="manual-head">
            <div>
              <h4>invoice / QR payment</h4>
              {#if manualNotice}
                <p class="manual-warning">{manualNotice}</p>
              {/if}
              <p>
                Pay the invoice with any Lightning wallet.
                {#if manualInvoices.some((inv) => inv.zapReceiptVerifiable === false)}
                  This provider may not publish a verifiable zap receipt.
                {:else}
                  The dialog closes when the zap receipt confirms.
                {/if}
              </p>
            </div>
            {#if manualInvoices.length > 1}
              <span>{manualPaidCount} / {manualInvoices.length} paid</span>
            {/if}
          </div>

          {#if manualInvoices.length > 1}
            <div class="invoice-tabs" aria-label="invoice selector">
              {#each manualInvoices as inv, i}
                <button
                  type="button"
                  class:active={i === manualIndex}
                  on:click={() => {
                    manualIndex = i;
                    copyState = '';
                  }}
                  class:paid={isManualInvoicePaid(inv.invoice)}
                >
                  {isManualInvoicePaid(inv.invoice) ? '✓ ' : ''}{(inv.recipient.millisats / 1000).toLocaleString()} sats
                </button>
              {/each}
            </div>
          {/if}

          {#if manualReceiptStatus}
            <div class="receipt-status">{manualReceiptStatus}</div>
          {/if}

          <div class="manual-target">
            <span>{activeManualInvoice.recipient.label}</span>
            <strong>{(activeManualInvoice.recipient.millisats / 1000).toLocaleString()} sats</strong>
          </div>

          {#if activeManualQr}
            <img class="qr" src={activeManualQr} alt="Lightning invoice QR code" />
          {/if}

          <div class="invoice-text">{activeManualInvoice.invoice}</div>

          <div class="manual-actions">
            <button type="button" class="ghost" on:click={() => copyInvoice(activeManualInvoice.invoice)}>
              {copyState || 'copy invoice'}
            </button>
            <a class="primary" href={lightningUriForInvoice(activeManualInvoice.invoice)}>open wallet</a>
          </div>
        </div>
      {/if}

      <div class="actions">
        {#if activeManualInvoice}
          <button type="button" class="ghost" on:click={resetManualPayment} disabled={working}>back</button>
          <button type="button" class="primary pixel-press" on:click={() => dispatch('close')} disabled={working}>
            done
          </button>
        {:else}
          <button type="button" class="ghost" on:click={() => dispatch('close')} disabled={working}>cancel</button>
          <button type="button" class="ghost" on:click={showInvoicePayment} disabled={working || !canZap}>
            {workingAction === 'invoice' ? 'creating…' : 'invoice / QR'}
          </button>
          <button type="button" class="primary pixel-press" on:click={pay} disabled={working || !canZap}>
            {workingAction === 'zap' ? 'paying…' : canZap ? `zap ${amount} sats` : 'enter sats'}
          </button>
        {/if}
      </div>
      <p class="muted">
        {#if canZap}
          your wallet pays one invoice directly to {curatorUnroutable ? 'Deepmarks' : 'the curator'}.
        {:else}
          enter a positive amount before zapping.
        {/if}
        no custody.
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
    max-height: 92vh;
    overflow: auto;
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
  .recipient { background: var(--paper-warm); border-radius: 8px; padding: 10px 12px; margin: 14px 0; }
  .recipient h4 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  .recipient .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  .recipient .row span { color: var(--muted); }
  .recipient .row strong { color: var(--ink-deep); }
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
  .manual {
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 12px;
    margin: 12px 0;
    background: var(--surface);
  }
  .manual-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .manual-head h4 {
    margin: 0 0 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--muted);
    font-weight: 600;
  }
  .manual-head p {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .manual-head .manual-warning {
    color: var(--coral-deep);
    background: var(--coral-soft);
    border-radius: 6px;
    padding: 6px 8px;
    margin-bottom: 6px;
  }
  .manual-head span {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .invoice-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }
  .invoice-tabs button {
    border: 1px solid var(--rule);
    border-radius: 100px;
    background: var(--surface);
    color: var(--ink);
    padding: 4px 9px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
  }
  .invoice-tabs button.active {
    border-color: var(--zap);
    color: var(--zap);
    font-weight: 600;
  }
  .invoice-tabs button.paid {
    border-color: #2d8a4f;
    color: #2d8a4f;
    background: #ecf8ef;
  }
  .receipt-status {
    margin: 0 0 10px;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--paper-warm);
    color: var(--muted);
    font-size: 11px;
    text-align: center;
  }
  .manual-target {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    margin-bottom: 10px;
  }
  .manual-target span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .manual-target strong {
    color: var(--ink-deep);
    white-space: nowrap;
  }
  .qr {
    display: block;
    width: min(256px, 100%);
    height: auto;
    aspect-ratio: 1;
    margin: 8px auto 10px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: #fff;
  }
  .invoice-text {
    max-height: 76px;
    overflow: auto;
    word-break: break-all;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.35;
    color: var(--muted);
    background: var(--paper-warm);
    border-radius: 6px;
    padding: 8px;
  }
  .manual-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
  .primary { background: var(--zap); color: #1a0f0c; border: 0; padding: 8px 16px; border-radius: 100px; font-weight: 600; cursor: pointer; font-family: inherit; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
  .primary:hover:not(:disabled) { background: #d97706; }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink); padding: 8px 16px; border-radius: 100px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .muted { color: var(--muted); font-size: 11px; margin: 0; text-align: center; }
</style>
