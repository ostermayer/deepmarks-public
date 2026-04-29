<script lang="ts">
  import { detectFormat, importers, type ImportFormat } from '$lib/importers';
  import { publishBatch, type BatchEvent } from '$lib/importers/batch-publish';
  import type { BookmarkInput } from '$lib/nostr/bookmarks';
  import { canSign, currentSession } from '$lib/stores/session';

  let pickedFormat: ImportFormat | null = null;
  let parsed: BookmarkInput[] = [];
  let parseError = '';
  let visibility: 'private' | 'public' = 'private';

  let publishing = false;
  let progress: BatchEvent[] = [];

  async function onFileSelected(e: Event) {
    parseError = '';
    parsed = [];
    progress = [];
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const format = pickedFormat ?? detectFormat(file.name, text);
    if (!format) {
      parseError = `Couldn't detect format for ${file.name}. Pick one explicitly.`;
      return;
    }
    pickedFormat = format;
    try {
      parsed = format.parse(text);
      if (parsed.length === 0) parseError = 'No bookmarks found in this file.';
    } catch (err) {
      parseError = (err as Error).message;
    }
  }

  function pickFormat(f: ImportFormat) {
    pickedFormat = f;
    parsed = [];
    progress = [];
    parseError = '';
  }

  async function startPublish() {
    if (!$canSign) {
      parseError = 'Connect a signer to import.';
      return;
    }
    progress = [];
    publishing = true;
    try {
      const session = currentSession();
      const iter = publishBatch(parsed, {
        visibility,
        ownerPubkey: session.pubkey!
      });
      for await (const evt of iter) {
        progress = [...progress, evt];
      }
    } catch (e) {
      parseError = (e as Error).message;
    } finally {
      publishing = false;
    }
  }

  $: succeeded = progress.filter((p) => p.status === 'ok').length;
  $: failed = progress.filter((p) => p.status === 'failed').length;
  $: lastFailures = progress.filter((p) => p.status === 'failed').slice(-3);
</script>

<svelte:head><title>import — Deepmarks</title></svelte:head>

<div class="page">
  <h1>import bookmarks</h1>
  <p class="lede">
    Pick a source. We parse the file in the browser, batch-sign each bookmark with your active
    signer, and publish to your relays. Nothing leaves the page in plaintext for private bookmarks.
  </p>

  <div class="sources">
    {#each importers as f}
      <button
        type="button"
        class="source"
        class:active={pickedFormat?.id === f.id}
        on:click={() => pickFormat(f)}
      >
        <strong>{f.label}</strong>
        <span>.{f.extension}</span>
      </button>
    {/each}
  </div>

  <div class="picker">
    <label class="file-input">
      <input type="file" on:change={onFileSelected} accept=".html,.htm,.json,.csv" />
      <span>choose file…</span>
    </label>
    {#if pickedFormat}
      <span class="muted">format: {pickedFormat.label}</span>
    {/if}
  </div>

  {#if parseError}
    <div class="error">{parseError}</div>
  {/if}

  {#if parsed.length > 0 && !publishing && progress.length === 0}
    <section class="preview">
      <h2>preview · {parsed.length} bookmark{parsed.length === 1 ? '' : 's'}</h2>
      <ul>
        {#each parsed.slice(0, 5) as b}
          <li>
            <strong>{b.title || b.url}</strong>
            <span class="url">{b.url}</span>
            {#if b.tags?.length}
              <span class="tags">
                {#each b.tags as t}<span class="tag">{t}</span>{/each}
              </span>
            {/if}
          </li>
        {/each}
        {#if parsed.length > 5}
          <li class="more">…and {parsed.length - 5} more</li>
        {/if}
      </ul>

      <fieldset>
        <legend>visibility</legend>
        <label>
          <input type="radio" bind:group={visibility} value="private" /> 🔒 private (encrypted, only you)
        </label>
        <label>
          <input type="radio" bind:group={visibility} value="public" /> share publicly on the network
        </label>
      </fieldset>

      <button class="primary" type="button" on:click={startPublish} disabled={!$canSign || publishing}>
        publish {parsed.length} bookmark{parsed.length === 1 ? '' : 's'}
      </button>
      {#if !$canSign}
        <p class="muted">Sign in first.</p>
      {/if}
    </section>
  {/if}

  {#if progress.length > 0}
    <section class="results">
      <h2>{publishing ? 'publishing…' : 'done'}</h2>
      <div class="bar">
        <div class="fill" style:width={`${(progress.length / parsed.length) * 100}%`}></div>
      </div>
      <p class="counts">
        <strong>{succeeded}</strong> ok
        {#if failed > 0}
          · <strong class="fail">{failed}</strong> failed
        {/if}
        · {progress.length} / {parsed.length}
      </p>
      {#if lastFailures.length > 0}
        <ul class="failures">
          {#each lastFailures as f}
            <li><span class="url">{f.url}</span> — {f.error}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page { max-width: 720px; margin: 0 auto; padding: 36px 24px 60px; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); letter-spacing: -0.4px; margin: 0 0 8px; }
  .lede { color: var(--ink); margin: 0 0 24px; line-height: 1.6; }
  .sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .source { background: var(--surface); border: 1px solid var(--rule); padding: 14px 16px; border-radius: 10px; cursor: pointer; text-align: left; font-family: inherit; color: var(--ink); display: block; }
  .source:hover, .source.active { border-color: var(--coral); }
  .source strong { display: block; font-size: 13px; color: var(--ink-deep); margin-bottom: 2px; }
  .source span { font-size: 11px; color: var(--muted); font-family: 'Courier New', monospace; }
  .picker { display: flex; gap: 12px; align-items: center; margin: 16px 0; }
  .file-input input { display: none; }
  .file-input span {
    display: inline-block; padding: 8px 16px; background: var(--paper-warm); border: 1px solid var(--rule);
    border-radius: 100px; cursor: pointer; font-size: 13px; color: var(--ink-deep);
  }
  .file-input span:hover { border-color: var(--coral); color: var(--coral); }
  .muted { color: var(--muted); font-size: 12px; }
  .error { padding: 10px 14px; background: var(--coral-soft); color: var(--coral-deep); border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  .preview, .results { margin-top: 24px; }
  .preview h2, .results h2 { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 1.5px; margin: 0 0 12px; padding-bottom: 6px; font-weight: 600; border-bottom: 1px solid var(--rule); }
  .preview ul { list-style: none; padding: 0; margin: 0 0 20px; }
  .preview li { padding: 8px 0; border-bottom: 1px dashed var(--rule); }
  .preview li strong { display: block; color: var(--ink-deep); font-size: 13px; }
  .preview li .url { display: block; color: var(--muted); font-family: 'Courier New', monospace; font-size: 10px; margin-top: 2px; }
  .preview li .tag { background: var(--surface); border: 1px solid var(--rule); padding: 1px 8px; margin-right: 3px; border-radius: 10px; font-size: 10px; color: var(--link); }
  .preview li.more { color: var(--muted); font-style: italic; padding: 6px 0; }
  fieldset { border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
  legend { padding: 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  fieldset label { display: block; padding: 4px 0; font-size: 13px; cursor: pointer; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 10px 18px; border-radius: 100px; font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .bar { height: 4px; background: var(--rule); border-radius: 100px; overflow: hidden; margin-bottom: 8px; }
  .fill { height: 100%; background: var(--archive); transition: width 0.2s; }
  .counts { margin: 4px 0; font-size: 13px; color: var(--ink); }
  .counts .fail { color: var(--coral-deep); }
  .failures { list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px; color: var(--coral-deep); }
  .failures .url { font-family: 'Courier New', monospace; }
</style>
