<script lang="ts">
  // Self-contained API-access panel. Three states:
  //   1. first load  → fetch existing keys, show list or empty state
  //   2. created     → show the freshly generated plaintext key ONCE, with copy
  //   3. steady      → list of metadata rows with rotate (= create+revoke) / revoke
  //
  // The panel degrades gracefully for non-lifetime users: the backend returns
  // 402 on POST /api/v1/keys, which we surface as an upgrade nudge.

  import { onMount } from 'svelte';
  import { api, ApiError, type ApiKeyMetadata } from '$lib/api/client';
  import { canSign } from '$lib/stores/session';
  import { relativeTime } from '$lib/util/time';

  let loading = true;
  let keys: ApiKeyMetadata[] = [];
  let error = '';
  let freshlyCreatedKey: string | null = null;
  let copied = false;
  let newLabel = '';
  let creating = false;

  async function refresh() {
    loading = true;
    error = '';
    try {
      keys = await api.keys.list();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        error = 'Sign in with a signer to manage API keys.';
      } else {
        error = (e as Error).message;
      }
    } finally {
      loading = false;
    }
  }

  async function create() {
    error = '';
    creating = true;
    try {
      const r = await api.keys.create(newLabel.trim() || 'unnamed');
      freshlyCreatedKey = r.key;
      newLabel = '';
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        error = 'API access is available to lifetime-tier members (21,000 sats). See /pricing.';
      } else if (e instanceof ApiError && e.status === 401) {
        error = 'Sign in with a signer to create API keys.';
      } else {
        error = (e as Error).message;
      }
    } finally {
      creating = false;
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? Any apps using it will stop working immediately.')) return;
    try {
      await api.keys.revoke(id);
      await refresh();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function copy() {
    if (!freshlyCreatedKey) return;
    try {
      await navigator.clipboard.writeText(freshlyCreatedKey);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard denied — user can still select the shown value.
    }
  }

  function dismissReveal() {
    freshlyCreatedKey = null;
    copied = false;
  }

  onMount(() => {
    if ($canSign) void refresh();
    else loading = false;
  });
</script>

<section>
  <h2>api access</h2>
  <p class="lede">
    Programmatic access for lifetime-tier members (21,000 sats). Use the key as
    a <code>Bearer</code> token against <code>{`${location.origin.replace('5173', '4000')}/api/v1`}</code>
    to list bookmarks, publish pre-signed <code>kind:39701</code> events, start archive
    purchases, and more. Keys rotate any time.
  </p>

  {#if !$canSign}
    <div class="hint">Sign in with a signer (browser extension or nsec) to manage API keys.</div>
  {:else}
    <div class="create-row">
      <input
        type="text"
        placeholder="label (e.g. 'my python script')"
        maxlength="80"
        bind:value={newLabel}
        on:keydown={(e) => e.key === 'Enter' && !creating && create()}
      />
      <button class="primary" type="button" on:click={create} disabled={creating}>
        {creating ? 'creating…' : '+ new key'}
      </button>
    </div>

    {#if freshlyCreatedKey}
      <div class="reveal" role="alert">
        <div class="reveal-head">
          <strong>save this key now — we won't show it again</strong>
          <button type="button" class="close" aria-label="dismiss" on:click={dismissReveal}>×</button>
        </div>
        <code class="key-value">{freshlyCreatedKey}</code>
        <div class="reveal-actions">
          <button type="button" class="copy" on:click={copy}>
            {copied ? 'copied ✓' : 'copy'}
          </button>
          <span class="muted">Store it in a password manager or secrets store. Revoke any time.</span>
        </div>
      </div>
    {/if}

    {#if error}<div class="error">{error}</div>{/if}

    {#if loading}
      <div class="muted">loading…</div>
    {:else if keys.length === 0}
      <div class="muted">no keys yet. Create one above.</div>
    {:else}
      <table class="keys">
        <thead>
          <tr>
            <th>label</th>
            <th>created</th>
            <th>last used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each keys as k (k.id)}
            <tr>
              <td>{k.label}</td>
              <td class="muted">{relativeTime(k.createdAt)}</td>
              <td class="muted">{relativeTime(k.lastUsedAt)}</td>
              <td class="row-actions">
                <button type="button" class="ghost" on:click={() => revoke(k.id)}>revoke</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</section>

<style>
  section { margin-top: 32px; }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  .lede { color: var(--ink); font-size: 13px; line-height: 1.55; margin: 0 0 16px; }
  .lede code {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    background: var(--paper-warm);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .hint { color: var(--muted); font-size: 13px; padding: 8px 0; }
  .create-row { display: flex; gap: 8px; margin-bottom: 12px; }
  .create-row input {
    flex: 1;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink);
    font-family: inherit;
    font-size: 13px;
  }
  .primary {
    background: var(--coral);
    color: var(--on-coral);
    border: 0;
    padding: 8px 16px;
    border-radius: 100px;
    font-weight: 500;
    cursor: pointer;
    font-size: 13px;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .reveal {
    background: var(--zap-soft);
    border: 1px solid var(--zap);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 16px;
  }
  .reveal-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .reveal-head strong { color: var(--ink-deep); font-size: 13px; }
  .close {
    background: transparent;
    border: 0;
    font-size: 20px;
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .key-value {
    display: block;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: var(--ink-deep);
    background: var(--surface);
    padding: 10px 12px;
    border-radius: 6px;
    word-break: break-all;
    border: 1px solid var(--rule);
    margin-bottom: 8px;
  }
  .reveal-actions { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .copy {
    background: transparent;
    border: 1px solid var(--coral);
    color: var(--coral);
    border-radius: 100px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .copy:hover { background: var(--coral); color: var(--on-coral); }
  .error {
    padding: 10px 12px;
    background: var(--coral-soft);
    color: var(--coral-deep);
    border-radius: 8px;
    font-size: 12px;
    margin-bottom: 12px;
  }
  .muted { color: var(--muted); font-size: 12px; }
  .keys { width: 100%; border-collapse: collapse; font-size: 13px; }
  .keys th, .keys td {
    text-align: left;
    padding: 8px 6px;
    border-bottom: 1px dashed var(--rule);
  }
  .keys th {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--muted);
    font-weight: 600;
  }
  .keys .row-actions { text-align: right; }
  .ghost {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--ink);
    border-radius: 100px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
  }
  .ghost:hover { border-color: var(--coral-deep); color: var(--coral-deep); }
</style>
