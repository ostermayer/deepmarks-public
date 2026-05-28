<script lang="ts">
  import { session } from '$lib/stores/session';
  import {
    archiveBackfillStatus,
    maybeBackfill,
  } from '$lib/nostr/lifetime-archive-backfill';

  $: status = $archiveBackfillStatus;
  $: visible = !!status.pubkey && status.pubkey === $session.pubkey && (
    status.state === 'checking' ||
    status.state === 'queueing' ||
    status.state === 'queued' ||
    status.state === 'complete' ||
    status.state === 'error' ||
    (status.state === 'paused' && status.message.includes('connect your signer'))
  );
  $: tone = status.state === 'error'
    ? 'error'
    : status.state === 'complete'
      ? 'complete'
      : status.state === 'paused'
        ? 'paused'
        : 'active';
  $: headline = status.state === 'checking'
    ? 'archive check'
    : status.state === 'queueing'
      ? 'archive queue running'
      : status.state === 'queued'
        ? 'archive jobs queued'
        : status.state === 'complete'
          ? 'archive check complete'
          : status.state === 'paused'
            ? 'archive queue paused'
            : 'archive queue needs attention';
</script>

{#if visible}
  <div class={`archive-status ${tone}`} role="status" aria-live="polite">
    <div class="copy">
      <strong>{headline}</strong>
      <span>
        {status.message}
        {#if status.totalMissing > 0}
          · {status.queued} new{status.skipped ? ` · ${status.skipped} already queued` : ''}{status.failed ? ` · ${status.failed} failed` : ''}
        {/if}
      </span>
    </div>
    {#if status.state !== 'checking' && status.state !== 'queueing'}
      <button type="button" on:click={() => void maybeBackfill(true)}>
        check now
      </button>
    {/if}
  </div>
{/if}

<style>
  .archive-status {
    max-width: 980px;
    margin: 0 auto 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    border: 1px solid var(--rule);
    border-left-width: 4px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }
  .archive-status.active { border-left-color: var(--archive); }
  .archive-status.complete { border-left-color: var(--link); }
  .archive-status.paused { border-left-color: var(--muted); }
  .archive-status.error { border-left-color: var(--coral-deep); }
  .copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  strong {
    color: var(--ink-deep);
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 13px;
  }
  span {
    color: var(--muted);
    line-height: 1.35;
  }
  button {
    flex: 0 0 auto;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  @media (max-width: 720px) {
    .archive-status {
      margin-left: 16px;
      margin-right: 16px;
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
