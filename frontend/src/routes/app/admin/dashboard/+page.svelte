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
  interface Dashboard {
    ts: number;
    boxes: {
      redis: BoxStatus; meilisearch: BoxStatus; strfry: BoxStatus;
      voltage: BoxStatus; archiveWorker: BoxStatus; bunker: BoxStatus;
    };
    relay: { url: string; registeredPubkeys: number; watchedContacts: number; eventCounts: Record<string, number> };
    queues: Record<string, number>;
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
      <p class="kv"><span>registered pubkeys</span><strong>{data.relay.registeredPubkeys}</strong></p>
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
    max-width: 920px;
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
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border, #eee); vertical-align: top; }
  td.name { width: 12rem; opacity: 0.75; word-break: break-all; }
  td.latency { text-align: right; opacity: 0.6; font-variant-numeric: tabular-nums; }
  td.dot { width: 1.5rem; text-align: center; font-weight: bold; }
  td.dot.ok { color: #2a8; }
  td.dot.bad { color: #d33; }
  td.name.critical { color: #d33; font-weight: bold; }
  td.name.warning { color: #c80; font-weight: bold; }
  td.name.info { color: #468; }
  .kv { display: flex; justify-content: space-between; padding: 0.2rem 0; border-bottom: 1px solid var(--border, #eee); }
  .kv span { opacity: 0.6; }
  .kv code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; }
  strong.warn { color: #c80; }
</style>
