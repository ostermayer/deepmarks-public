<script lang="ts">
  import { archiveLookupKeys, myArchiveRecords } from '$lib/stores/my-archives';
  import type { ArchiveRecord } from '$lib/api/client';
  import { ownBookmarks, refreshOwnBookmarks } from '$lib/stores/own-bookmarks';
  import { canSign, session } from '$lib/stores/session';
  import { userSettings } from '$lib/stores/user-settings';
  import {
    archiveQueueRevision,
    archiveQueueStats,
    forgetArchiveQueueUrls,
    refreshQueuedArchiveStatuses,
  } from '$lib/nostr/archive';
  import {
    archiveBackfillStatus,
    maybeBackfill,
  } from '$lib/nostr/lifetime-archive-backfill';
  import { deleteOwnBookmarks } from '$lib/nostr/bulk-delete';
  import {
    buildBookmarkCleanupAudit,
    canonicalCleanupUrl,
    type BookmarkCleanupCandidate,
  } from '$lib/bookmark-cleanup';
  import SettingsSection from './SettingsSection.svelte';

  export let isLifetime = false;

  let selectedIds = new Set<string>();
  let selectedForSignature = '';
  let candidatesExpanded = false;
  let scanning = false;
  let queueingMissing = false;
  let deleting = false;
  let deleteArmed = false;
  let deleteArmTimer: ReturnType<typeof setTimeout> | null = null;
  let status = '';
  let error = '';

  $: archiveRevision = $archiveQueueRevision;
  $: queueStats = queueStatsFor($session.pubkey, archiveRevision);
  $: archivedUrlKeys = buildArchivedUrlKeys($myArchiveRecords);
  $: archiveByDefault = isLifetime && (
    $userSettings.archiveAllByDefault || !$userSettings.archiveDefaultManualOverride
  );
  $: audit = buildBookmarkCleanupAudit({
    bookmarks: $ownBookmarks,
    archivedUrlKeys,
    failedArchiveUrls: queueStats.failedUrls,
    queuedArchiveUrls: queueStats.queuedUrls,
    archiveByDefault,
  });
  $: auditSignature = audit.candidates
    .map((candidate) => `${candidate.id}:${candidate.reasons.join(',')}:${candidate.selectedByDefault}`)
    .join('|');
  $: if (auditSignature !== selectedForSignature) {
    selectedIds = new Set(audit.candidates.filter((candidate) => candidate.selectedByDefault).map((candidate) => candidate.id));
    selectedForSignature = auditSignature;
    deleteArmed = false;
    candidatesExpanded = audit.candidates.length > 0 && audit.candidates.length <= 12;
  }
  $: selectedCandidates = audit.candidates.filter((candidate) => selectedIds.has(candidate.id));
  $: selectedCount = selectedCandidates.length;
  $: backfillMessage = $archiveBackfillStatus.pubkey === $session.pubkey
    ? $archiveBackfillStatus.message
    : '';

  function queueStatsFor(pubkey: string | null, revision: number) {
    void revision;
    return pubkey
      ? archiveQueueStats(pubkey)
      : { queuedUrls: new Set<string>(), failedUrls: new Set<string>(), unknownUrls: new Set<string>() };
  }

  function buildArchivedUrlKeys(records: readonly ArchiveRecord[]): Set<string> {
    const keys = new Set<string>();
    for (const record of records) {
      for (const key of archiveLookupKeys(record.url)) {
        keys.add(key);
        keys.add(canonicalCleanupUrl(key));
      }
    }
    return keys;
  }

  async function scan(): Promise<void> {
    const pubkey = $session.pubkey;
    if (!pubkey) {
      error = 'sign in to scan cleanup candidates';
      return;
    }
    scanning = true;
    error = '';
    status = '';
    try {
      refreshOwnBookmarks();
      const completedUrls = new Set<string>();
      for (const record of $myArchiveRecords) {
        completedUrls.add(record.url);
        for (const key of archiveLookupKeys(record.url)) completedUrls.add(key);
      }
      const result = await refreshQueuedArchiveStatuses(pubkey, completedUrls, 200);
      status = result.checked > 0 || result.completed > 0 || result.failed > 0
        ? `checked ${result.checked} archive job${result.checked === 1 ? '' : 's'} · ${result.failed} failed · ${result.completed} completed`
        : 'cleanup scan refreshed';
    } catch (e) {
      error = (e as Error).message || 'cleanup scan failed';
    } finally {
      scanning = false;
    }
  }

  async function queueMissingArchives(): Promise<void> {
    if (!archiveByDefault) {
      error = 'archive-by-default is not enabled';
      return;
    }
    if (!$canSign) {
      error = 'connect your signer to queue missing archives';
      return;
    }
    queueingMissing = true;
    error = '';
    status = '';
    try {
      await maybeBackfill(true);
      status = $archiveBackfillStatus.message || 'missing archives queued';
      refreshOwnBookmarks();
    } catch (e) {
      error = (e as Error).message || 'could not queue missing archives';
    } finally {
      queueingMissing = false;
    }
  }

  function toggleCandidate(id: string, checked: boolean): void {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    selectedIds = next;
    deleteArmed = false;
  }

  function selectRecommended(): void {
    selectedIds = new Set(audit.candidates.filter((candidate) => candidate.selectedByDefault).map((candidate) => candidate.id));
    deleteArmed = false;
  }

  function selectArchiveFailures(): void {
    selectedIds = new Set(audit.candidates.filter((candidate) => candidate.reasons.includes('archive-failed')).map((candidate) => candidate.id));
    deleteArmed = false;
  }

  function clearSelection(): void {
    selectedIds = new Set();
    deleteArmed = false;
  }

  function armDelete(): void {
    if (deleteArmTimer) clearTimeout(deleteArmTimer);
    deleteArmed = true;
    deleteArmTimer = setTimeout(() => { deleteArmed = false; }, 6_000);
  }

  async function deleteSelected(): Promise<void> {
    if (!$canSign) {
      error = 'connect your signer to delete cleanup candidates';
      return;
    }
    if (selectedCandidates.length === 0) {
      error = 'select at least one cleanup candidate';
      return;
    }
    if (!deleteArmed) {
      armDelete();
      return;
    }
    if (deleteArmTimer) {
      clearTimeout(deleteArmTimer);
      deleteArmTimer = null;
    }
    deleting = true;
    deleteArmed = false;
    error = '';
    status = '';
    try {
      const result = await deleteOwnBookmarks(selectedCandidates.map((candidate) => candidate.bookmark), 'cleanup');
      if ($session.pubkey && result.deleted.length > 0) {
        forgetArchiveQueueUrls($session.pubkey, result.deleted.map((item) => item.url));
      }
      if (result.failed.length > 0) {
        error = `deleted ${result.deleted.length}, failed ${result.failed.length}: ${result.failed[0]?.error ?? 'unknown error'}`;
      } else {
        status = `deleted ${result.deleted.length} bookmark${result.deleted.length === 1 ? '' : 's'}`;
      }
      selectedIds = new Set();
      refreshOwnBookmarks();
    } catch (e) {
      error = (e as Error).message || 'cleanup delete failed';
    } finally {
      deleting = false;
    }
  }

  function displayTitle(candidate: BookmarkCleanupCandidate): string {
    const title = candidate.bookmark.title?.trim();
    return title && title !== candidate.bookmark.url ? title : candidate.bookmark.url;
  }

  function displayHost(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '') || url;
    } catch {
      return url;
    }
  }
</script>

<SettingsSection title="cleanup">
  <p class="settings-section-copy">
    Find duplicate saves and failed archive jobs. Missing archives are queued again instead of shown as delete candidates.
  </p>

  <div class="cleanup-stats" aria-label="cleanup summary">
    <span><strong>{audit.duplicateGroups}</strong> duplicate group{audit.duplicateGroups === 1 ? '' : 's'}</span>
    <span><strong>{audit.failedArchives}</strong> failed archive{audit.failedArchives === 1 ? '' : 's'}</span>
    <span><strong>{audit.missingArchives}</strong> archive{audit.missingArchives === 1 ? '' : 's'} to queue</span>
  </div>

  <div class="cleanup-actions">
    <button type="button" class="tiny" on:click={scan} disabled={scanning || queueingMissing || deleting}>
      {scanning ? 'scanning…' : 'scan now'}
    </button>
    <button
      type="button"
      class="tiny"
      on:click={queueMissingArchives}
      disabled={audit.missingArchives === 0 || scanning || queueingMissing || deleting}
    >
      {queueingMissing ? 'queueing…' : 'queue missing archives'}
    </button>
    <button type="button" class="tiny" on:click={selectRecommended} disabled={audit.recommendedDeletes === 0 || deleting}>
      recommended
    </button>
    <button type="button" class="tiny" on:click={selectArchiveFailures} disabled={audit.failedArchives === 0 || deleting}>
      archive failures
    </button>
    <button type="button" class="tiny" on:click={clearSelection} disabled={selectedCount === 0 || deleting}>
      clear
    </button>
  </div>

  {#if status}<p class="cleanup-status">{status}</p>{/if}
  {#if !status && backfillMessage}<p class="cleanup-status">{backfillMessage}</p>{/if}
  {#if error}<p class="status-error">{error}</p>{/if}

  {#if audit.candidates.length === 0}
    <p class="muted compact">no cleanup candidates right now.</p>
  {:else}
    <div class="cleanup-head">
      <span>{selectedCount} selected from {audit.candidates.length} cleanup candidate{audit.candidates.length === 1 ? '' : 's'}</span>
      <button type="button" class="tiny" on:click={() => (candidatesExpanded = !candidatesExpanded)}>
        {candidatesExpanded ? 'hide list' : 'show list'}
      </button>
      <button
        type="button"
        class="danger"
        class:armed={deleteArmed}
        on:click={deleteSelected}
        disabled={selectedCount === 0 || deleting}
      >
        {deleting ? 'deleting…' : deleteArmed ? `confirm delete ${selectedCount}` : 'delete selected'}
      </button>
    </div>

    {#if deleteArmed}
      <p class="cleanup-warning">Click confirm before this resets. Deleted public bookmarks publish a NIP-09 delete; private bookmarks publish an encrypted tombstone.</p>
    {/if}

    {#if candidatesExpanded}
      <ul class="cleanup-list">
        {#each audit.candidates as candidate (candidate.id)}
          <li>
            <div class="candidate-top">
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.has(candidate.id)}
                  on:change={(event) => toggleCandidate(candidate.id, event.currentTarget.checked)}
                  disabled={deleting}
                />
                <span>{displayTitle(candidate)}</span>
              </label>
              <span class="reason">{candidate.reasonLabels.join(' · ')}</span>
            </div>
            <a class="candidate-url" href={candidate.bookmark.url} target="_blank" rel="noreferrer">
              {displayHost(candidate.bookmark.url)}
            </a>
            <p class="candidate-detail">{candidate.details.join(' · ')}</p>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</SettingsSection>

<style>
  .cleanup-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin: 12px 0;
  }
  .cleanup-stats span {
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--surface);
    color: var(--ink);
    font-size: 12px;
    min-width: 0;
  }
  .cleanup-stats strong {
    display: block;
    color: var(--ink-deep);
    font-size: 18px;
    line-height: 1.1;
  }
  .cleanup-actions,
  .cleanup-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .cleanup-head {
    justify-content: space-between;
    margin: 14px 0 8px;
    color: var(--ink);
    font-size: 13px;
  }
  .cleanup-head > span {
    margin-right: auto;
  }
  .tiny {
    background: var(--surface);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 6px 10px;
    border-radius: 999px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .tiny:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral-deep);
  }
  .tiny:disabled,
  .danger:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .danger {
    border: 1px solid var(--coral);
    background: var(--surface);
    color: var(--coral-deep);
    border-radius: 999px;
    padding: 7px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .danger.armed {
    background: var(--coral);
    color: var(--on-coral);
  }
  .cleanup-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cleanup-list li {
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    padding: 10px 12px;
  }
  .candidate-top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
  }
  .candidate-top label {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    min-width: 0;
    color: var(--ink-deep);
    font-weight: 600;
    line-height: 1.35;
  }
  .candidate-top input {
    margin-top: 3px;
    flex: 0 0 auto;
  }
  .candidate-top label span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .reason {
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 3px 8px;
    color: var(--ink);
    font-size: 11px;
    white-space: nowrap;
  }
  .candidate-url {
    display: inline-block;
    margin: 6px 0 0 24px;
    color: var(--link) !important;
    font-size: 12px;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .candidate-detail,
  .cleanup-warning,
  .cleanup-status {
    margin: 8px 0 0;
    color: var(--ink);
    font-size: 12px;
    line-height: 1.5;
  }
  .cleanup-warning {
    color: var(--coral-deep);
  }
  .cleanup-status {
    color: var(--archive);
  }
  .status-error {
    color: var(--coral-deep);
    background: var(--coral-soft);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    margin: 8px 0 0;
  }
  .muted {
    color: var(--ink-deep);
    font-size: 14px;
    line-height: 1.6;
  }
  .compact {
    margin: 8px 0 0;
  }
  @media (max-width: 640px) {
    .cleanup-stats {
      grid-template-columns: 1fr;
    }
    .candidate-top {
      grid-template-columns: 1fr;
    }
    .reason {
      justify-self: start;
      white-space: normal;
    }
  }
</style>
