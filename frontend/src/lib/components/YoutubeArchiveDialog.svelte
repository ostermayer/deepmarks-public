<script lang="ts">
  // YouTube archive purchase flow.
  //
  //  1. user pastes a YouTube URL
  //  2. client generates a fresh AES-256 key (kept locally + published
  //     to the user's NIP-51 archive-keys set after success)
  //  3. POST /add-on/youtube-archive/invoice → BOLT-11 invoice + jobId
  //  4. show invoice (copy + native open-in-wallet)
  //  5. poll /add-on/youtube-archive/status/:paymentHash until done
  //  6. once worker reports blobHash + title + channel, store the
  //     (blobHash → archiveKey) mapping so the user can decrypt later

  import { createEventDispatcher, onDestroy } from 'svelte';
  import { session } from '$lib/stores/session';
  import { buildNip98AuthHeader } from '$lib/api/client';
  import { config } from '$lib/config';
  import { generateArchiveKey, addArchiveKeyToSet } from '$lib/nostr/archive-keys';
  import { parseYoutubeVideoId } from '$lib/youtube';

  const dispatch = createEventDispatcher();

  let url = '';
  let parsing = false;
  let error: string | null = null;
  let phase: 'enter' | 'invoice' | 'paid' | 'done' | 'failed' = 'enter';

  // Invoice state
  let invoice = '';
  let paymentHash = '';
  let amountSats = 0;
  let videoId = '';
  let alreadyArchived = false;
  let archiveKey = '';

  // Result state
  let blobHash = '';
  let videoTitle = '';
  let videoChannel = '';

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function close(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    dispatch('close');
  }

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  async function buyInvoice(): Promise<void> {
    error = null;
    const id = parseYoutubeVideoId(url);
    if (!id) {
      error = 'paste a YouTube video URL (watch?v=, youtu.be/, embed/, or shorts/)';
      return;
    }
    if (!$session.pubkey) {
      error = 'sign in to purchase add-ons';
      return;
    }
    parsing = true;
    try {
      archiveKey = generateArchiveKey();
      const apiUrl = `${config.apiBase}/add-on/youtube-archive/invoice`;
      const body = JSON.stringify({ url, archiveKey });
      const auth = await buildNip98AuthHeader(apiUrl, 'POST', body);
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error((errJson as { error?: string }).error ?? `invoice ${res.status}`);
      }
      const json = (await res.json()) as {
        paymentHash: string; invoice: string; amountSats: number;
        videoId: string; alreadyArchived: boolean;
      };
      invoice = json.invoice;
      paymentHash = json.paymentHash;
      amountSats = json.amountSats;
      videoId = json.videoId;
      alreadyArchived = json.alreadyArchived;
      phase = 'invoice';
      // Stash the archiveKey + paymentHash so a refresh mid-purchase
      // can recover and still publish the key mapping once the worker
      // reports the blobHash.
      try {
        localStorage.setItem(
          `deepmarks-yt-archive-pending:${paymentHash}`,
          JSON.stringify({ archiveKey, videoId, createdAt: Date.now() }),
        );
      } catch { /* private mode — best effort */ }
      startPolling();
    } catch (e) {
      error = (e as Error).message ?? 'failed to create invoice';
    } finally {
      parsing = false;
    }
  }

  function startPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void pollOnce(), 4_000);
    void pollOnce();
  }

  async function pollOnce(): Promise<void> {
    if (!paymentHash) return;
    try {
      const res = await fetch(`${config.apiBase}/add-on/youtube-archive/status/${paymentHash}`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        status: string;
        done?: {
          status?: string; blobHash?: string;
          videoTitle?: string; videoChannel?: string;
        } | null;
      };
      if (json.status === 'paid' || json.status === 'enqueued') {
        if (phase === 'invoice') phase = 'paid';
      }
      if (json.done) {
        if (json.done.status === 'ok' && json.done.blobHash) {
          blobHash = json.done.blobHash;
          videoTitle = json.done.videoTitle ?? '';
          videoChannel = json.done.videoChannel ?? '';
          phase = 'done';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          // Persist the (blobHash → archiveKey) mapping to NIP-51 so
          // any device the user signs in on can decrypt the archive.
          if ($session.pubkey && archiveKey) {
            void addArchiveKeyToSet(blobHash, archiveKey, $session.pubkey)
              .catch((err) => console.warn('addArchiveKeyToSet failed', err));
          }
          try { localStorage.removeItem(`deepmarks-yt-archive-pending:${paymentHash}`); }
          catch { /* tolerable */ }
        } else if (json.done.status === 'failed') {
          phase = 'failed';
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      }
    } catch {
      // network blip — keep polling
    }
  }

  function copyInvoice(): void {
    try {
      void navigator.clipboard.writeText(invoice);
    } catch { /* tolerable */ }
  }

  function displayTitle(): string {
    if (videoTitle && videoChannel) return `${videoTitle} — ${videoChannel}`;
    if (videoTitle) return videoTitle;
    return videoId ? `youtube · ${videoId}` : 'youtube video';
  }
</script>

<div class="overlay" on:click|self={close} on:keydown={(e) => { if (e.key === 'Escape') close(); }} role="dialog" aria-modal="true" tabindex="-1">
  <div class="modal">
    <header>
      <h2>archive a YouTube video</h2>
      <button type="button" class="close" on:click={close} aria-label="close">×</button>
    </header>

    {#if phase === 'enter'}
      <p class="hint">we'll download the video at up to 720p, encrypt it with a fresh key only you hold, and store it in our private bucket. the bookmark URL itself stays as-is — public if you save it publicly, private if not.</p>
      <label class="field">
        <span>YouTube URL</span>
        <input
          type="url"
          bind:value={url}
          placeholder="https://www.youtube.com/watch?v=…"
          autocomplete="off"
          on:keydown={(e) => { if (e.key === 'Enter') void buyInvoice(); }}
        />
      </label>
      {#if error}<p class="error">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="ghost" on:click={close}>cancel</button>
        <button type="button" class="cta" on:click={() => void buyInvoice()} disabled={parsing || !url.trim()}>
          {parsing ? 'creating invoice…' : 'continue — 150,000 sats'}
        </button>
      </div>
    {:else if phase === 'invoice'}
      <p class="hint">scan or copy the invoice. {alreadyArchived ? 'another user has already archived this video, so your copy will be available almost immediately after payment.' : 'archiving usually completes within a few minutes after payment.'}</p>
      <div class="invoice-box">
        <code>{invoice}</code>
      </div>
      <div class="actions">
        <button type="button" class="ghost" on:click={copyInvoice}>copy invoice</button>
        <a class="cta" href={`lightning:${invoice}`}>open in wallet</a>
      </div>
      <p class="status">amount: {amountSats.toLocaleString()} sats · waiting for payment…</p>
    {:else if phase === 'paid'}
      <p class="status">payment received — running yt-dlp on Box B. this usually takes 1–3 minutes for a typical video.</p>
      <div class="spinner" aria-hidden="true"></div>
    {:else if phase === 'done'}
      <p class="success">archived: <strong>{displayTitle()}</strong></p>
      <p class="hint">your archive is now available under archives. you can find it by the video's title and channel.</p>
      <div class="actions">
        <button type="button" class="cta" on:click={close}>done</button>
      </div>
    {:else if phase === 'failed'}
      <p class="error">archive failed. your purchase will be auto-refunded as a credit you can apply to another archive.</p>
      <div class="actions">
        <button type="button" class="ghost" on:click={close}>close</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
    padding: 16px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 12px;
    max-width: 520px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px;
    color: var(--ink-deep);
  }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  header h2 { margin: 0; font-size: 16px; color: var(--ink-deep); }
  .close { background: none; border: 0; font-size: 24px; color: var(--ink); cursor: pointer; line-height: 1; }
  .hint { color: var(--ink); font-size: 13px; line-height: 1.5; }
  .field { display: block; margin: 16px 0; }
  .field span { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .field input {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--rule); background: var(--paper);
    color: var(--ink-deep); font-size: 14px;
    box-sizing: border-box;
  }
  .invoice-box {
    background: var(--paper-warm);
    border-radius: 6px;
    padding: 10px;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
    margin: 12px 0;
  }
  .invoice-box code { background: none; font-size: 10px; color: var(--ink-deep); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
  .cta {
    background: var(--coral); color: var(--on-coral);
    border: 0; padding: 8px 16px; border-radius: 100px;
    font-size: 14px; font-weight: 500; cursor: pointer;
    text-decoration: none; display: inline-block;
  }
  .cta:hover { background: var(--coral-deep); }
  .cta:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost {
    background: var(--surface); color: var(--ink-deep);
    border: 1px solid var(--rule); padding: 8px 16px;
    border-radius: 100px; font-size: 14px; cursor: pointer;
  }
  .error { color: var(--coral-deep); font-size: 13px; margin-top: 8px; }
  .status { color: var(--ink); font-size: 13px; margin-top: 8px; }
  .success { color: var(--ink-deep); font-size: 15px; margin-top: 8px; }
  .success strong { color: var(--coral-deep); }
  .spinner {
    width: 24px; height: 24px;
    border: 3px solid var(--rule);
    border-top-color: var(--coral);
    border-radius: 50%;
    margin: 16px auto;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
