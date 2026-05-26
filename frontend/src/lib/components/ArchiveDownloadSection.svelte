<script lang="ts">
  import { Archive, Download, Loader2 } from 'lucide-svelte';
  import { api, type ArchiveRecord } from '$lib/api/client';
  import { downloadArchivesZip } from '$lib/archives/download';
  import { canSign, session } from '$lib/stores/session';
  import { isNativeShell } from '$lib/native/runtime';
  import SettingsSection from './SettingsSection.svelte';

  let working = false;
  let error = '';
  let status = '';
  let completed = 0;
  let total = 0;
  let failed = 0;
  let nativeShell = isNativeShell();

  async function downloadAll() {
    error = '';
    status = '';
    completed = 0;
    total = 0;
    failed = 0;

    if (!$canSign || !$session.pubkey) {
      error = 'connect your signer to download archives';
      return;
    }

    working = true;
    try {
      status = 'loading archive list...';
      const records: ArchiveRecord[] = await api.archives.listAll();
      total = records.length;
      if (records.length === 0) {
        status = 'no archives yet';
        return;
      }
      status = `preparing 0 / ${records.length}`;
      const result = await downloadArchivesZip(records, {
        pubkey: $session.pubkey,
        onProgress: (p) => {
          completed = p.completed;
          total = p.total;
          if (p.status === 'failed') failed += 1;
          status = `preparing ${p.completed} / ${p.total}`;
        },
      });
      status = result.failed
        ? `downloaded zip with ${result.ok} archived page${result.ok === 1 ? '' : 's'} and ${result.failed} error note${result.failed === 1 ? '' : 's'}`
        : `downloaded ${result.ok} archived page${result.ok === 1 ? '' : 's'}`;
    } catch (e) {
      error = (e as Error).message ?? 'archive download failed';
    } finally {
      working = false;
    }
  }
</script>

<SettingsSection title="archive downloads">
  <p class="settings-section-copy">
    Download every archived page in your account as a zip. Private archives are decrypted on this {nativeShell ? 'device' : 'browser'} before they are added.
  </p>

  <div class="actions">
    <button
      type="button"
      class="primary"
      on:click={downloadAll}
      disabled={working || !$canSign}
      title={$canSign ? 'download all archived pages' : 'connect a signer to download archives'}
    >
      {#if working}
        <span class="spin"><Loader2 size={15} /></span>
      {:else}
        <Download size={15} />
      {/if}
      <span>download zip</span>
    </button>
    <a class="ghost" href="/app/archives">
      <Archive size={14} />
      <span>my archives</span>
    </a>
  </div>

  {#if status}
    <p class="status">{status}</p>
  {:else if !$canSign}
    <p class="status">connect your signer to download archives.</p>
  {/if}
  {#if total > 0 && working}
    <progress max={total} value={completed}></progress>
    {#if failed > 0}<p class="status">{failed} failed so far; the zip will include error notes.</p>{/if}
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</SettingsSection>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .primary,
  .ghost {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border-radius: 100px;
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    text-decoration: none;
    cursor: pointer;
  }
  .primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ghost {
    background: transparent;
    color: var(--ink-deep);
    border: 1px solid var(--rule);
  }
  .ghost:hover {
    border-color: var(--coral);
    color: var(--coral);
    text-decoration: none;
  }
  .primary :global(svg),
  .ghost :global(svg) { display: block; }
  .spin {
    display: inline-flex;
    animation: spin 900ms linear infinite;
  }
  .status {
    color: var(--muted);
    font-size: 12px;
    margin: 10px 0 0;
  }
  .error {
    color: #a33;
    font-size: 12px;
    margin: 10px 0 0;
  }
  progress {
    width: 100%;
    height: 8px;
    margin-top: 10px;
    accent-color: var(--coral);
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
