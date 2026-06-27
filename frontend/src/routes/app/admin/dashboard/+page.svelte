<script lang="ts">
  // Operator dashboard — single page that polls /admin/dashboard.
  //
  // Visibility-gated: only the user can see this and only if their
  // pubkey is in the server's ADMIN_PUBKEYS set. The server rejects
  // the NIP-98 auth if not, so non-admins see "access denied".
  //
  // Polling: 5 s while the tab is visible, paused while hidden so a
  // forgotten background tab doesn't hammer the backend.

  import { onDestroy, onMount } from 'svelte';
  import { session } from '$lib/stores/session';
  import { buildNip98AuthHeader } from '$lib/api/client';
  import { config } from '$lib/config';

  interface BoxStatus { ok: boolean; status: string; latencyMs?: number }
  interface PaidMetricRange {
    label: string;
    from: number | null;
    to: number;
    lifetimeMembers: number;
    mediaArchiveAddons: number;
    estimatedRevenueSats: number;
  }
  interface MonthlyMetric {
    month: string;
    from: number;
    to: number;
    lifetimeMembers: number;
    mediaArchiveAddons: number;
    estimatedRevenueSats: number;
  }
  interface ArchiveAuditSummary {
    at: number;
    scanned: number;
    completed: number;
    live: number;
    failed: number;
    stale: number;
    pending: number;
    renotified: number;
    renotifyDeferred: number;
    requeued: number;
    requeueDeferred: number;
    rescued: number;
    rescueDeferred: number;
    waybackMiss: number;
    markedLostFailed: number;
    skippedNonRescuable: number;
    errors: number;
    truncated: boolean;
  }
  interface ArchiveSlaSummary {
    terminalSampled: number;
    completed: number;
    failed: number;
    mediaCompleted: number;
    mediaFailed: number;
    webpageCompleted: number;
    webpageFailed: number;
    completedLast24h: number;
    failedLast24h: number;
    averageCompletionSeconds: number | null;
    durationSampled: number;
    failureReasons: Array<{ reason: string; count: number }>;
  }
  interface ArchiveHealthSummary {
    ok: boolean;
    status: string;
    pending: number;
    processing: number;
    activeWorkers: number;
    staleProcessing: number;
    mediaPending: number;
    mediaProcessing: number;
    pendingSampled: number;
    oldestQueuedAt: number | null;
    oldestQueuedAgeSeconds: number | null;
    workerHeartbeatWorkerId: string | null;
    workerHeartbeatAgeSeconds: number | null;
    lastCallbackAt: number | null;
    lastCallbackAgeSeconds: number | null;
    lastAudit: ArchiveAuditSummary | null;
    lastAuditAgeSeconds: number | null;
    sla: ArchiveSlaSummary;
    issues: string[];
    warnings: string[];
  }
  interface Dashboard {
    ts: number;
    metrics: {
      growth: {
        registeredPubkeys: number;
        usernameClaims: number;
        lifetimeMembers: number;
        mediaArchiveAddons: number;
        lifetimeConversionPct: number;
        publicBookmarks: number;
        privateBookmarkChunks: number;
        serverKnownBookmarkRecords: number;
        publicBookmarksPerRegisteredPubkey: number;
        watchedContacts: number;
      };
      revenue: {
        estimatedLifetimeSats: number;
        mediaArchiveSats: number;
        estimatedTotalSats: number;
        ranges: PaidMetricRange[];
        monthly: MonthlyMetric[];
        notes: string[];
      };
      health: {
        okBoxes: number;
        totalBoxes: number;
        queuedJobs: number;
        recentAlerts: number;
      };
    };
    boxes: {
      redis: BoxStatus; meilisearch: BoxStatus; strfry: BoxStatus;
      voltage: BoxStatus; archiveWorker: BoxStatus; bunker: BoxStatus;
    };
    relay: { url: string; registeredPubkeys: number; watchedContacts: number; eventCounts: Record<string, number> };
    queues: Record<string, number>;
    archiveQueue: ArchiveHealthSummary;
    archiveAudit: ArchiveAuditSummary | null;
    workers: Record<string, Record<string, number>>;
    alerts: Array<{ key: string; severity: string; subject: string; sentAt: number }>;
  }

  let data: Dashboard | null = null;
  let error: string | null = null;
  let loading = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function poll(): Promise<void> {
    if (loading || !$session.pubkey) return;
    loading = true;
    const url = `${config.apiBase}/admin/dashboard`;
    try {
      const auth = await buildNip98AuthHeader(url, 'GET');
      const res = await fetch(url, { headers: { Authorization: auth } });
      if (res.status === 401 || res.status === 403) {
        error = 'access denied — your pubkey is not an admin';
        return;
      }
      if (!res.ok) {
        error = `dashboard ${res.status}`;
        return;
      }
      data = (await res.json()) as Dashboard;
      error = null;
    } catch (e) {
      error = (e as Error).message ?? 'fetch failed';
    } finally {
      loading = false;
    }
  }

  function onVisibility(): void {
    if (document.hidden) {
      if (timer) { clearInterval(timer); timer = null; }
    } else if (!timer) {
      void poll();
      timer = setInterval(poll, 5_000);
    }
  }

  onMount(() => {
    void poll();
    timer = setInterval(poll, 5_000);
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  function statusClass(ok: boolean): string {
    return ok ? 'ok' : 'bad';
  }

  function relTime(ms: number): string {
    const age = Date.now() - ms;
    if (age < 60_000) return `${Math.round(age / 1_000)}s ago`;
    if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
    return `${Math.round(age / 3_600_000)}h ago`;
  }

  function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }

  function formatSats(value: number): string {
    return `${formatNumber(value)} sats`;
  }

  function formatAgeSeconds(value: number | null): string {
    if (value == null) return '—';
    if (value < 60) return `${value}s`;
    if (value < 3_600) return `${Math.round(value / 60)}m`;
    if (value < 86_400) return `${Math.round(value / 3_600)}h`;
    return `${Math.round(value / 86_400)}d`;
  }
</script>

<svelte:head><title>deepmarks · admin dashboard</title></svelte:head>

<main class="dashboard">
  <h1>admin dashboard</h1>
  <p class="hint">polled every 5s while this tab is visible · last refresh {data ? relTime(data.ts) : '—'}</p>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if data}
    <section>
      <h2>growth</h2>
      <div class="metric-grid">
        <article>
          <span>relay-allowed pubkeys</span>
          <strong>{formatNumber(data.metrics.growth.registeredPubkeys)}</strong>
          <small>includes signed-in users and followed curators; not a login count</small>
        </article>
        <article>
          <span>lifetime members</span>
          <strong>{formatNumber(data.metrics.growth.lifetimeMembers)}</strong>
          <small>paid member count</small>
        </article>
        <article>
          <span>short handles claimed</span>
          <strong>{formatNumber(data.metrics.growth.usernameClaims)}</strong>
          <small>active /u/name claims</small>
        </article>
        <article>
          <span>media add-ons</span>
          <strong>{formatNumber(data.metrics.growth.mediaArchiveAddons)}</strong>
        </article>
        <article>
          <span>public bookmarks</span>
          <strong>{formatNumber(data.metrics.growth.publicBookmarks)}</strong>
          <small>{data.metrics.growth.publicBookmarksPerRegisteredPubkey} per relay-allowed pubkey</small>
        </article>
        <article>
          <span>private chunks</span>
          <strong>{formatNumber(data.metrics.growth.privateBookmarkChunks)}</strong>
          <small>encrypted NIP-51 records, not item count</small>
        </article>
        <article>
          <span>watched contacts</span>
          <strong>{formatNumber(data.metrics.growth.watchedContacts)}</strong>
          <small>followed pubkeys queued for server-side outbox ingest</small>
        </article>
      </div>
    </section>

    <section>
      <h2>revenue</h2>
      <div class="metric-grid">
        <article>
          <span>estimated total</span>
          <strong>{formatSats(data.metrics.revenue.estimatedTotalSats)}</strong>
        </article>
        <article>
          <span>lifetime</span>
          <strong>{formatSats(data.metrics.revenue.estimatedLifetimeSats)}</strong>
        </article>
        <article>
          <span>media archive add-on</span>
          <strong>{formatSats(data.metrics.revenue.mediaArchiveSats)}</strong>
        </article>
        <article>
          <span>health snapshot</span>
          <strong>{data.metrics.health.okBoxes}/{data.metrics.health.totalBoxes} boxes ok</strong>
          <small>{formatNumber(data.metrics.health.queuedJobs)} queued jobs · {formatNumber(data.metrics.health.recentAlerts)} alerts</small>
        </article>
      </div>

      <h3>paid members by range</h3>
      <table>
        <thead>
          <tr>
            <th>range</th>
            <th>lifetime</th>
            <th>media add-on</th>
            <th>estimated revenue</th>
          </tr>
        </thead>
        <tbody>
          {#each data.metrics.revenue.ranges as range}
            <tr>
              <td class="name">{range.label}</td>
              <td>{formatNumber(range.lifetimeMembers)}</td>
              <td>{formatNumber(range.mediaArchiveAddons)}</td>
              <td class="latency">{formatSats(range.estimatedRevenueSats)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3>last 12 months</h3>
      <table>
        <thead>
          <tr>
            <th>month</th>
            <th>lifetime</th>
            <th>media add-on</th>
            <th>estimated revenue</th>
          </tr>
        </thead>
        <tbody>
          {#each data.metrics.revenue.monthly as month}
            <tr>
              <td class="name">{month.month}</td>
              <td>{formatNumber(month.lifetimeMembers)}</td>
              <td>{formatNumber(month.mediaArchiveAddons)}</td>
              <td class="latency">{formatSats(month.estimatedRevenueSats)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <ul class="notes">
        {#each data.metrics.revenue.notes as note}
          <li>{note}</li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>boxes</h2>
      <table>
        <tbody>
          {#each Object.entries(data.boxes) as [name, box]}
            <tr>
              <td class="name">{name}</td>
              <td class="dot {statusClass(box.ok)}">{box.ok ? '●' : '✗'}</td>
              <td>{box.status}</td>
              <td class="latency">{box.latencyMs != null ? `${box.latencyMs}ms` : ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section>
      <h2>relay</h2>
      <p class="kv"><span>url</span><code>{data.relay.url}</code></p>
      <p class="kv"><span>relay-allowed pubkeys</span><strong>{data.relay.registeredPubkeys}</strong></p>
      <p class="kv"><span>watched contacts (outbox)</span><strong>{data.relay.watchedContacts}</strong></p>
      <h3>event counts</h3>
      <table>
        <tbody>
          {#each Object.entries(data.relay.eventCounts) as [kind, count]}
            <tr><td class="name">{kind}</td><td><strong>{count}</strong></td></tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section>
      <h2>queues</h2>
      <table>
        <tbody>
          {#each Object.entries(data.queues) as [name, depth]}
            <tr>
              <td class="name">{name}</td>
              <td><strong class:warn={depth > 100}>{depth}</strong></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <section>
      <h2>archive queue</h2>
      <p class="hint">
        <span class="inline-status {statusClass(data.archiveQueue.ok)}">{data.archiveQueue.ok ? 'ok' : 'attention'}</span>
        {data.archiveQueue.status}
      </p>
      <div class="metric-grid">
        <article>
          <span>pending</span>
          <strong>{formatNumber(data.archiveQueue.pending)}</strong>
          <small>{formatNumber(data.archiveQueue.mediaPending)} media in sampled jobs</small>
        </article>
        <article>
          <span>processing</span>
          <strong>{formatNumber(data.archiveQueue.processing)}</strong>
          <small>{formatNumber(data.archiveQueue.activeWorkers)} active workers · {formatNumber(data.archiveQueue.staleProcessing)} stale</small>
        </article>
        <article>
          <span>oldest queued</span>
          <strong>{formatAgeSeconds(data.archiveQueue.oldestQueuedAgeSeconds)}</strong>
          <small>{data.archiveQueue.oldestQueuedAt ? relTime(data.archiveQueue.oldestQueuedAt * 1000) : 'no pending jobs'}</small>
        </article>
        <article>
          <span>worker heartbeat</span>
          <strong>{formatAgeSeconds(data.archiveQueue.workerHeartbeatAgeSeconds)}</strong>
          <small>{data.archiveQueue.workerHeartbeatWorkerId ?? 'missing'}</small>
        </article>
      </div>
      {#if data.archiveQueue.issues.length > 0}
        <ul class="notes issues">
          {#each data.archiveQueue.issues as issue}
            <li>{issue}</li>
          {/each}
        </ul>
      {/if}
      {#if data.archiveQueue.warnings.length > 0}
        <ul class="notes">
          {#each data.archiveQueue.warnings as warning}
            <li>{warning}</li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>archive SLA</h2>
      <p class="hint">
        sampled {formatNumber(data.archiveQueue.sla.terminalSampled)} terminal jobs
      </p>
      <div class="metric-grid">
        <article>
          <span>last 24h</span>
          <strong>{formatNumber(data.archiveQueue.sla.completedLast24h)} done</strong>
          <small>{formatNumber(data.archiveQueue.sla.failedLast24h)} failed</small>
        </article>
        <article>
          <span>avg completion</span>
          <strong>{formatAgeSeconds(data.archiveQueue.sla.averageCompletionSeconds)}</strong>
          <small>{formatNumber(data.archiveQueue.sla.durationSampled)} duration samples</small>
        </article>
        <article>
          <span>media terminal</span>
          <strong>{formatNumber(data.archiveQueue.sla.mediaCompleted)} done</strong>
          <small>{formatNumber(data.archiveQueue.sla.mediaFailed)} failed</small>
        </article>
        <article>
          <span>page terminal</span>
          <strong>{formatNumber(data.archiveQueue.sla.webpageCompleted)} done</strong>
          <small>{formatNumber(data.archiveQueue.sla.webpageFailed)} failed</small>
        </article>
      </div>
      {#if data.archiveQueue.sla.failureReasons.length > 0}
        <table>
          <tbody>
            {#each data.archiveQueue.sla.failureReasons as item}
              <tr><td class="name">{item.reason}</td><td><strong>{formatNumber(item.count)}</strong></td></tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="hint">no failed terminal jobs in the sample</p>
      {/if}
    </section>

    <section>
      <h2>archive audit</h2>
      {#if data.archiveAudit}
        <p class="hint">
          last pass {relTime(data.archiveAudit.at * 1000)}
          {data.archiveAudit.truncated ? ' · truncated' : ''}
        </p>
        <div class="metric-grid">
          <article>
            <span>scanned</span>
            <strong>{formatNumber(data.archiveAudit.scanned)}</strong>
            <small>{formatNumber(data.archiveAudit.completed)} completed · {formatNumber(data.archiveAudit.live)} live</small>
          </article>
          <article>
            <span>rescued</span>
            <strong>{formatNumber(data.archiveAudit.rescued)}</strong>
            <small>{formatNumber(data.archiveAudit.renotified)} re-notified callbacks</small>
          </article>
          <article>
            <span>problems</span>
            <strong>{formatNumber(data.archiveAudit.failed + data.archiveAudit.stale)}</strong>
            <small>{formatNumber(data.archiveAudit.failed)} failed · {formatNumber(data.archiveAudit.stale)} stale</small>
          </article>
          <article>
            <span>unrescued</span>
            <strong>{formatNumber(data.archiveAudit.waybackMiss + data.archiveAudit.skippedNonRescuable)}</strong>
            <small>{formatNumber(data.archiveAudit.markedLostFailed)} marked failed · {formatNumber(data.archiveAudit.errors)} errors</small>
          </article>
        </div>
      {:else}
        <p class="hint">no archive audit pass reported yet</p>
      {/if}
    </section>

    <section>
      <h2>workers</h2>
      {#each Object.entries(data.workers) as [name, stats]}
        <h3>{name}</h3>
        <table>
          <tbody>
            {#each Object.entries(stats) as [k, v]}
              <tr><td class="name">{k}</td><td><strong>{v}</strong></td></tr>
            {/each}
          </tbody>
        </table>
      {/each}
    </section>

    <section>
      <h2>recent alerts</h2>
      {#if data.alerts.length === 0}
        <p class="hint">no recent alerts</p>
      {:else}
        <table>
          <tbody>
            {#each data.alerts as a}
              <tr>
                <td class="name {a.severity}">{a.severity}</td>
                <td>{a.subject}</td>
                <td class="latency">{relTime(a.sentAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {:else if !error}
    <p class="hint">loading…</p>
  {/if}
</main>

<style>
  .dashboard {
    max-width: 1120px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  h2 { margin-top: 2rem; font-size: 1.1rem; }
  h3 { margin-top: 1rem; font-size: 0.95rem; opacity: 0.8; }
  .hint { color: var(--muted, #888); font-size: 0.85rem; margin: 0.25rem 0 1rem; }
  .error { background: #fee; color: #900; padding: 0.5rem 0.75rem; border-radius: 6px; margin: 1rem 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th {
    padding: 0.35rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid var(--border, #eee);
    color: var(--muted, #667);
    font-weight: 700;
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border, #eee); vertical-align: top; }
  td.name { width: 12rem; opacity: 0.75; word-break: break-all; }
  td.latency { text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
  td.dot { width: 1.5rem; text-align: center; font-weight: bold; }
  td.dot.ok { color: #2a8; }
  td.dot.bad { color: #d33; }
  .inline-status { font-weight: 700; margin-right: 0.35rem; }
  .inline-status.ok { color: #2a8; }
  .inline-status.bad { color: #d33; }
  td.name.critical { color: #d33; font-weight: bold; }
  td.name.warning { color: #c80; font-weight: bold; }
  td.name.info { color: #468; }
  .kv { display: flex; justify-content: space-between; padding: 0.2rem 0; border-bottom: 1px solid var(--border, #eee); }
  .kv span { opacity: 0.6; }
  .kv code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; }
  strong.warn { color: #c80; }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
  }
  article {
    border: 1px solid var(--border, #dce6ee);
    border-left: 4px solid #f36f63;
    border-radius: 8px;
    padding: 0.75rem 0.85rem;
    background: color-mix(in srgb, var(--panel, #fff) 94%, #f36f63 6%);
  }
  article span {
    display: block;
    color: var(--muted, #667);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  article strong {
    display: block;
    margin-top: 0.25rem;
    font-size: 1.35rem;
  }
  article small {
    display: block;
    margin-top: 0.15rem;
    color: var(--muted, #667);
    font-size: 0.78rem;
  }
  .notes {
    color: var(--muted, #667);
    font-size: 0.82rem;
    padding-left: 1.1rem;
  }
  .notes.issues { color: #b22; }
</style>
