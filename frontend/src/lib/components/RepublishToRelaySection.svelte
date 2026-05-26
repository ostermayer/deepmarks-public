<script lang="ts">
  // One-click "republish my whole local library to relay.deepmarks.org"
  // settings section.
  //
  // For users whose bookmarks predate the registered-pubkey
  // writePolicy or whose earlier publishes failed to reach the
  // canonical relay (flaky NIP-65, third-party import, etc.).
  // Walks both the public and private halves of ownBookmarks,
  // builds publish templates, enqueues each into the durable-
  // publish queue. The queue drains in the background; the user
  // can close the app and it keeps publishing.
  //
  // This is the consumer-facing UX. The actual plumbing lives in
  // lib/nostr/republish-all.ts.

  import { ownBookmarks } from '$lib/stores/own-bookmarks';
  import { session } from '$lib/stores/session';
  import { pendingPublishCount } from '$lib/nostr/pending-publish';
  import SettingsSection from './SettingsSection.svelte';

  let resyncing = false;
  let resyncProgress = '';
  let resyncError = '';
  let lastResultSummary = '';
  /** Reactive pending-publish count for the signed-in pubkey. Polls
   *  every second while a resync is in flight or while there's still
   *  a backlog — gives the user real-time visibility into how much
   *  work the durable queue has left. */
  let pendingCount = 0;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  $: ownTotal = $ownBookmarks.length;
  $: publicCount = $ownBookmarks.filter((b) => !b.eventId?.startsWith('private:')).length;
  $: privateCount = ownTotal - publicCount;

  $: if ($session.pubkey) {
    pendingCount = pendingPublishCount($session.pubkey);
    startPolling();
  } else {
    stopPolling();
  }

  function startPolling(): void {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      if (!$session.pubkey) return;
      pendingCount = pendingPublishCount($session.pubkey);
      if (pendingCount === 0 && !resyncing) stopPolling();
    }, 1000);
  }

  function stopPolling(): void {
    if (!pollInterval) return;
    clearInterval(pollInterval);
    pollInterval = null;
  }

  async function republishAll(): Promise<void> {
    if (resyncing || !$session.pubkey) return;
    resyncing = true;
    resyncError = '';
    lastResultSummary = '';
    let publicQueued = 0;
    let privateQueued = 0;
    try {
      const { republishAllOwnBookmarks } = await import('$lib/nostr/republish-all');
      resyncProgress = `preparing private set (${privateCount} entries)…`;
      for await (const step of republishAllOwnBookmarks($session.pubkey, 'private')) {
        if (step.phase === 'queued' || step.phase === 'draining') {
          privateQueued = step.queued;
        }
        resyncProgress = step.detail ?? `private: ${step.queued}/${step.total}`;
      }
      resyncProgress = `preparing public bookmarks (${publicCount} entries)…`;
      for await (const step of republishAllOwnBookmarks($session.pubkey, 'public')) {
        if (step.phase === 'queued' || step.phase === 'draining') {
          publicQueued = step.queued;
        }
        resyncProgress = step.detail ?? `public: ${step.queued}/${step.total}`;
      }
      lastResultSummary = `queued ${publicQueued} public bookmark${publicQueued === 1 ? '' : 's'} and ${privateQueued} private-set chunk${privateQueued === 1 ? '' : 's'}. Publishing in the background — safe to close the app.`;
    } catch (e) {
      resyncError = (e as Error).message ?? 'republish failed';
    } finally {
      resyncing = false;
      resyncProgress = '';
      // Force-refresh the pending count immediately and keep
      // polling so the user sees the queue drain.
      if ($session.pubkey) pendingCount = pendingPublishCount($session.pubkey);
      startPolling();
    }
  }
</script>

<SettingsSection title="republish to deepmarks relay">
  <p class="settings-section-copy">
    Push every bookmark in your local library to <code>relay.deepmarks.org</code>.
    Useful after an import, when switching devices, or any time your bookmarks
    appear on one Deepmarks surface but not another. Safe to run as often as
    you want.
  </p>
  <p class="settings-section-copy">
    Local cache currently has <strong>{ownTotal.toLocaleString()}</strong>
    bookmark{ownTotal === 1 ? '' : 's'}
    {#if ownTotal > 0}
      ({publicCount.toLocaleString()} public, {privateCount.toLocaleString()} private)
    {/if}.
    {#if pendingCount > 0}
      <strong>{pendingCount.toLocaleString()}</strong> still in the publish queue.
    {/if}
  </p>
  <div class="resync-row">
    <button
      type="button"
      class="primary"
      on:click={() => void republishAll()}
      disabled={resyncing || !$session.signer || ownTotal === 0}
    >
      {resyncing
        ? 'republishing…'
        : `republish ${ownTotal.toLocaleString()} bookmark${ownTotal === 1 ? '' : 's'} to relay`}
    </button>
  </div>
  {#if resyncing}
    <p class="settings-section-copy progress">{resyncProgress}</p>
  {:else if lastResultSummary}
    <p class="settings-section-copy progress">{lastResultSummary}</p>
  {/if}
  {#if resyncError}<p class="status-error">{resyncError}</p>{/if}
</SettingsSection>

<style>
  .resync-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 12px 0 0;
  }
  button {
    font: inherit;
    padding: 9px 16px;
    border-radius: 6px;
    cursor: pointer;
  }
  button.primary {
    background: var(--coral);
    color: white;
    border: 1px solid var(--coral-deep, var(--coral));
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .progress {
    margin-top: 8px;
  }
  .status-error {
    color: var(--coral-deep);
    font-size: 13px;
    margin-top: 8px;
  }
</style>
