<script lang="ts">
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import { api } from '$lib/api/client';
  import { detectFormat, importers, type ImportFormat } from '$lib/importers';
  import { publishBatch, type BatchEvent } from '$lib/importers/batch-publish';
  import TagChipInput from '$lib/components/TagChipInput.svelte';
  import type { BookmarkInput, ParsedBookmark } from '$lib/nostr/bookmarks';
  import { canSign, currentSession } from '$lib/stores/session';
  import { rememberOwnBookmarks } from '$lib/stores/own-bookmarks';
  import { getLifetimeStatus } from '$lib/nostr/lifetime-status';
  import { enqueueArchivePage, rememberArchiveQueueFailure } from '$lib/nostr/archive';
  import { userSettings } from '$lib/stores/user-settings';

  type ReviewPageSize = 10 | 25 | 50 | 100;
  type EditableField = 'title' | 'description';

  const REVIEW_PAGE_SIZES: ReviewPageSize[] = [10, 25, 50, 100];

  let pickedFormat: ImportFormat | null = null;
  let parsed: BookmarkInput[] = [];
  let parseError = '';
  let visibility: 'private' | 'public' = 'private';
  let reviewPageSize: ReviewPageSize = 25;
  let reviewPage = 0;

  let publishing = false;
  let progress: BatchEvent[] = [];
  let archiveProgress: BatchEvent[] = [];

  async function onFileSelected(e: Event) {
    parseError = '';
    parsed = [];
    progress = [];
    archiveProgress = [];
    reviewPage = 0;
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
      parsed = format.parse(text).map(normalizeForReview);
      if (parsed.length === 0) parseError = 'No bookmarks found in this file.';
    } catch (err) {
      parseError = (err as Error).message;
    }
  }

  function pickFormat(f: ImportFormat) {
    pickedFormat = f;
    parsed = [];
    progress = [];
    archiveProgress = [];
    parseError = '';
    reviewPage = 0;
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
      const events: BatchEvent[] = [];
      const imported: ParsedBookmark[] = [];
      const iter = publishBatch(parsed.map(normalizeForPublish), {
        visibility,
        ownerPubkey: session.pubkey!
      });
      for await (const evt of iter) {
        if (evt.bookmark) imported.push(evt.bookmark);
        events.push(evt);
        progress = [...events];
      }
      const privateSetFailed = events.some((p) => p.phase === 'private-set' && p.status === 'failed');
      const anyFailed = events.some((p) => p.status === 'failed');
      const privateCommitted = visibility === 'private' &&
        events.some((p) => p.phase === 'private-set' && p.status === 'ok') &&
        !privateSetFailed;
      if (visibility === 'public' || privateCommitted) {
        rememberOwnBookmarks(imported, visibility === 'public');
      }
      const archivesOk = !anyFailed ? await enqueueImportedArchives(imported, session.pubkey!) : true;
      if (!anyFailed && archivesOk) {
        void goto('/app/bookmarks');
      }
    } catch (e) {
      parseError = (e as Error).message;
    } finally {
      publishing = false;
    }
  }

  async function enqueueImportedArchives(bookmarks: ParsedBookmark[], pubkey: string): Promise<boolean> {
    const settings = get(userSettings);
    const lifetime = await isLifetimeMember(pubkey);
    if (!lifetime) return true;
    const archiveByDefault = settings.archiveAllByDefault || !settings.archiveDefaultManualOverride;
    if (!archiveByDefault) return true;

    const events: BatchEvent[] = [];
    for (let i = 0; i < bookmarks.length; i++) {
      const bookmark = bookmarks[i]!;
      try {
        const result = await enqueueArchivePage({
          url: bookmark.url,
          tier: visibility,
          pubkey,
          eventId: bookmark.eventId.startsWith('private:') ? undefined : bookmark.eventId,
          bookmarkSavedAt: bookmark.savedAt,
          lifetime: true,
          mirrorUrls: settings.backupBlossomServers,
          dedupe: true,
        });
        events.push({
          index: i,
          total: bookmarks.length,
          url: bookmark.url,
          status: 'ok',
          phase: 'archive',
          completedUnits: i + 1,
          totalUnits: bookmarks.length,
          eventId: result.jobId,
          detail: 'archive queued',
        });
      } catch (e) {
        rememberArchiveQueueFailure(pubkey, bookmark.url, (e as Error).message);
        events.push({
          index: i,
          total: bookmarks.length,
          url: bookmark.url,
          status: 'failed',
          phase: 'archive',
          completedUnits: i + 1,
          totalUnits: bookmarks.length,
          error: (e as Error).message,
        });
      }
      archiveProgress = [...events];
    }
    return !events.some((event) => event.status === 'failed');
  }

  async function isLifetimeMember(pubkey: string): Promise<boolean> {
    try {
      const status = await api.lifetime.status(pubkey);
      return status.isLifetimeMember;
    } catch {
      return get(getLifetimeStatus(pubkey));
    }
  }

  function normalizeTagList(tags: string[] | undefined): string[] {
    const out: string[] = [];
    for (const raw of tags ?? []) {
      const cleaned = raw.toLowerCase().replace(/[^a-z0-9.\-]+/g, ' ').trim();
      if (!cleaned) continue;
      for (const tag of cleaned.split(/\s+/)) {
        const trimmed = tag.replace(/^[.\-]+|[.\-]+$/g, '');
        if (trimmed && trimmed.length <= 40 && !out.includes(trimmed)) out.push(trimmed);
      }
    }
    return out;
  }

  function normalizeForReview(row: BookmarkInput): BookmarkInput {
    return {
      ...row,
      title: row.title ?? '',
      description: row.description ?? '',
      tags: normalizeTagList(row.tags),
    };
  }

  function normalizeForPublish(row: BookmarkInput): BookmarkInput {
    return {
      ...row,
      title: row.title?.trim() || undefined,
      description: row.description?.trim() || undefined,
      tags: normalizeTagList(row.tags),
    };
  }

  function setReviewPageSize(size: ReviewPageSize) {
    reviewPageSize = size;
    reviewPage = 0;
  }

  function goToReviewPage(page: number) {
    reviewPage = Math.max(0, Math.min(reviewTotalPages - 1, page));
  }

  function updateBookmark(index: number, patch: Partial<BookmarkInput>) {
    const current = parsed[index];
    if (!current) return;
    parsed = [
      ...parsed.slice(0, index),
      { ...current, ...patch },
      ...parsed.slice(index + 1),
    ];
  }

  function updateField(index: number, field: EditableField, value: string) {
    updateBookmark(index, { [field]: value });
  }

  function updateTags(index: number, tags: string[]) {
    updateBookmark(index, { tags: normalizeTagList(tags) });
  }

  function removeBookmark(index: number) {
    parsed = parsed.filter((_, i) => i !== index);
    if (parsed.length === 0) parseError = 'No bookmarks left to import.';
  }

  $: reviewTotalPages = Math.max(1, Math.ceil(parsed.length / reviewPageSize));
  $: if (reviewPage >= reviewTotalPages) reviewPage = reviewTotalPages - 1;
  $: reviewStart = parsed.length === 0 ? 0 : reviewPage * reviewPageSize;
  $: reviewEnd = Math.min(reviewStart + reviewPageSize, parsed.length);
  $: reviewItems = parsed.slice(reviewStart, reviewEnd);
  $: itemProgress = progress.filter((p) => p.index < parsed.length);
  $: archiveQueued = archiveProgress.filter((p) => p.status === 'ok').length;
  $: archiveFailed = archiveProgress.filter((p) => p.status === 'failed').length;
  $: prepared = itemProgress.filter((p) => p.status === 'prepared').length;
  $: publicSucceeded = itemProgress.filter((p) => p.status === 'ok').length;
  $: failed = progress.filter((p) => p.status === 'failed').length;
  $: lastFailures = progress.filter((p) => p.status === 'failed').slice(-3);
  $: lastArchiveFailures = archiveProgress.filter((p) => p.status === 'failed').slice(-3);
  $: latestProgress = progress.at(-1);
  $: latestArchiveProgress = archiveProgress.at(-1);
  $: publishCompletedUnits = latestProgress?.completedUnits ?? 0;
  $: publishTotalUnits = latestProgress?.totalUnits ?? parsed.length;
  $: completedUnits = latestArchiveProgress
    ? publishTotalUnits + latestArchiveProgress.completedUnits
    : publishCompletedUnits;
  $: totalUnits = latestArchiveProgress
    ? publishTotalUnits + latestArchiveProgress.totalUnits
    : publishTotalUnits;
  $: progressPercent = totalUnits === 0 ? 0 : Math.min(100, (completedUnits / totalUnits) * 100);
  $: progressPercentLabel = publishing && progressPercent < 100
    ? Math.floor(progressPercent)
    : Math.round(progressPercent);
  $: setProgress = progress.filter((p) => p.phase === 'private-set');
  $: privateSetFailed = setProgress.some((p) => p.status === 'failed');
  $: privateCommitted = visibility === 'private' && setProgress.some((p) => p.status === 'ok') && !privateSetFailed && !publishing;
  $: succeeded = visibility === 'private' ? (privateCommitted ? prepared : 0) : publicSucceeded;
  $: progressLabel = latestArchiveProgress && publishing
    ? 'queueing lifetime archives…'
    : progressStatusLabel(latestProgress, publishing, visibility, failed);

  function progressStatusLabel(
    latest: BatchEvent | undefined,
    isPublishing: boolean,
    mode: 'private' | 'public',
    failureCount: number,
  ): string {
    if (!latest) return mode === 'private' ? 'preparing private import…' : 'publishing bookmarks…';
    if (!isPublishing && failureCount > 0) {
      return mode === 'private'
        ? 'not saved — update or reload your signer and retry'
        : 'done with errors — retry is safe';
    }
    if (!isPublishing) return mode === 'private' ? 'saved encrypted private set' : 'done';
    if (latest.phase === 'private-set-encrypt') return latest.detail ?? 'encrypting private set chunks…';
    if (latest.phase === 'private-set') return latest.detail ?? 'publishing encrypted private set chunks…';
    return mode === 'private' ? 'preparing encrypted bookmarks…' : 'publishing bookmarks…';
  }
</script>

<svelte:head><title>import — Deepmarks</title></svelte:head>

<div class="page">
  <h1>import bookmarks</h1>
  <p class="lede">
    Pick a source. We parse the file in the browser, batch-sign each bookmark with your active
    signer, and post through Deepmarks to your relays. Nothing leaves the page in plaintext for private bookmarks.
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
      <div class="review-head">
        <h2>review · {parsed.length} bookmark{parsed.length === 1 ? '' : 's'}</h2>
        <div class="publish-action">
          <button class="primary" type="button" on:click={startPublish} disabled={!$canSign || publishing}>
            publish {parsed.length} bookmark{parsed.length === 1 ? '' : 's'}
          </button>
          {#if !$canSign}
            <p class="muted">Sign in first.</p>
          {/if}
        </div>
      </div>

      <fieldset class="visibility-panel">
        <legend>visibility</legend>
        <label>
          <input type="radio" bind:group={visibility} value="private" /> 🔒 private (encrypted, only you)
        </label>
        <label>
          <input type="radio" bind:group={visibility} value="public" /> share publicly on the network
        </label>
      </fieldset>

      <div class="review-list">
        {#each reviewItems as b, offset (`${reviewStart + offset}:${b.url}`)}
          {@const index = reviewStart + offset}
          <article class="review-row">
            <div class="row-top">
              <a class="row-url" href={b.url} target="_blank" rel="noreferrer">{b.url}</a>
              <button type="button" class="text-button" on:click={() => removeBookmark(index)}>skip</button>
            </div>
            <label>
              <span>title</span>
              <input
                type="text"
                value={b.title ?? ''}
                on:input={(event) => updateField(index, 'title', (event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label>
              <span>description</span>
              <textarea
                rows="2"
                value={b.description ?? ''}
                on:input={(event) => updateField(index, 'description', (event.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
            </label>
            <div class="tag-field">
              <span>tags</span>
              <TagChipInput
                tags={b.tags ?? []}
                placeholder="tags"
                on:change={(event) => updateTags(index, event.detail.tags)}
              />
            </div>
          </article>
        {/each}
      </div>

      <div class="review-controls">
        <div>
          <span class="control-label">review</span>
          <div class="page-size" aria-label="review page size">
            {#each REVIEW_PAGE_SIZES as size}
              <button
                type="button"
                class:active={reviewPageSize === size}
                on:click={() => setReviewPageSize(size)}
              >
                {size}
              </button>
            {/each}
          </div>
        </div>
        <div class="review-nav">
          <button type="button" on:click={() => goToReviewPage(reviewPage - 1)} disabled={reviewPage === 0}>
            previous
          </button>
          <span>{reviewStart + 1}-{reviewEnd} / {parsed.length}</span>
          <button
            type="button"
            on:click={() => goToReviewPage(reviewPage + 1)}
            disabled={reviewPage >= reviewTotalPages - 1}
          >
            load more
          </button>
        </div>
      </div>
    </section>
  {/if}

  {#if progress.length > 0}
    <section class="results">
      <h2>{publishing ? 'publishing…' : failed > 0 || archiveFailed > 0 ? 'import needs retry' : 'done'}</h2>
      <div class="bar">
        <div class="fill" style:width={`${progressPercent}%`}></div>
      </div>
      <p class="counts">
        {#if visibility === 'private' && !privateCommitted}
          <strong>{prepared}</strong> prepared
        {:else}
          <strong>{succeeded}</strong> saved
        {/if}
        {#if failed > 0}
          · <strong class="fail">{failed}</strong> failed
        {/if}
        · {itemProgress.length} / {parsed.length} bookmarks
        · {progressPercentLabel}%
      </p>
      <p class="stage">
        {progressLabel}
        {#if setProgress.length > 0}
          · {setProgress.length} encrypted set event{setProgress.length === 1 ? '' : 's'}
        {/if}
      </p>
      {#if lastFailures.length > 0}
        <ul class="failures">
          {#each lastFailures as f}
          <li><span class="url">{f.url}</span> — {f.error}</li>
        {/each}
      </ul>
      {/if}
      {#if archiveProgress.length > 0}
        <p class="stage">
          queued <strong>{archiveQueued}</strong> archive{archiveQueued === 1 ? '' : 's'}
          {#if archiveFailed > 0}
            · <strong class="fail">{archiveFailed}</strong> archive queue failure{archiveFailed === 1 ? '' : 's'}
          {/if}
        </p>
        {#if lastArchiveFailures.length > 0}
          <ul class="failures">
            {#each lastArchiveFailures as f}
              <li><span class="url">{f.url}</span> — {f.error}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if !publishing && (failed > 0 || archiveFailed > 0) && parsed.length > 0}
        <button class="primary retry" type="button" on:click={startPublish} disabled={!$canSign}>
          retry import
        </button>
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
  .review-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
  .publish-action { display: grid; justify-items: end; gap: 4px; flex: 0 0 auto; }
  .publish-action .muted { margin: 0; }
  .review-controls {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: end;
    border-top: 1px dashed var(--rule);
    padding-top: 12px;
  }
  .review-controls > div { display: grid; gap: 6px; }
  .control-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .page-size { display: inline-flex; gap: 2px; border: 1px solid var(--rule); border-radius: 8px; padding: 2px; background: var(--surface); }
  .page-size button, .review-nav button, .text-button {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .page-size button { min-width: 34px; padding: 4px 8px; border-radius: 6px; }
  .page-size button.active { background: var(--coral); color: var(--on-coral); }
  .review-nav { display: flex; align-items: center; justify-content: flex-end; gap: 12px; color: var(--muted); font-size: 12px; }
  .review-nav button { padding: 4px 0; color: var(--link); }
  .review-nav button:disabled { opacity: 0.45; cursor: not-allowed; }
  .review-list { display: grid; gap: 12px; margin-bottom: 12px; }
  .review-row { border: 1px solid var(--rule); border-radius: 8px; padding: 12px; background: var(--paper-warm); }
  .row-top { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .row-url {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--muted);
    font-family: 'Courier New', monospace;
    font-size: 11px;
    text-decoration: none;
  }
  .row-url:hover { color: var(--link); }
  .text-button { color: var(--coral-deep); flex: 0 0 auto; padding: 0; }
  .review-row label, .tag-field { display: grid; gap: 5px; margin-top: 9px; }
  .review-row label span, .tag-field > span { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px; }
  .review-row input, .review-row textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    padding: 8px 10px;
  }
  .review-row textarea { resize: vertical; line-height: 1.4; }
  .review-row input:focus, .review-row textarea:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
  fieldset { border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
  .visibility-panel { margin: 10px 0 14px; background: var(--paper-warm); }
  legend { padding: 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); font-weight: 600; }
  fieldset label { display: block; padding: 4px 0; font-size: 13px; cursor: pointer; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 10px 18px; border-radius: 100px; font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .bar { height: 4px; background: var(--rule); border-radius: 100px; overflow: hidden; margin-bottom: 8px; }
  .fill { height: 100%; background: var(--archive); transition: width 0.2s; }
  .counts { margin: 4px 0; font-size: 13px; color: var(--ink); }
  .counts .fail { color: var(--coral-deep); }
  .stage { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
  .failures { list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px; color: var(--coral-deep); }
  .failures .url { font-family: 'Courier New', monospace; }
  .retry { margin-top: 14px; }
  @media (max-width: 640px) {
    .review-head, .review-controls { align-items: stretch; flex-direction: column; }
    .publish-action { justify-items: stretch; }
    .publish-action .primary { width: 100%; }
    .review-nav { justify-content: space-between; }
  }
</style>
