<script lang="ts">
  import { exporters, downloadAsFile, generateJsonl, type ExportFormat } from '$lib/exporters';
  import { fetchOwnPrivateSet } from '$lib/nostr/private-bookmarks';
  import { parseBookmarkEvent, type ParsedBookmark, type SignedEventLike } from '$lib/nostr/bookmarks';
  import { getNdk } from '$lib/nostr/ndk';
  import { KIND } from '$lib/nostr/kinds';
  import { canSign, currentSession } from '$lib/stores/session';

  let format: ExportFormat['id'] | 'jsonl' = 'netscape';
  let includePublic = true;
  let includePrivate = true;
  let working = false;
  let status = '';
  let error = '';

  function bookmarkFromInnerTags(tags: string[][], curator: string): ParsedBookmark {
    // Inner-set entries don't have an event id; synthesize one from the URL
    // so downstream consumers can dedupe sanely.
    const url = tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const tagValues = tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '').filter(Boolean);
    return {
      url,
      title: tags.find((t) => t[0] === 'title')?.[1] ?? url,
      description: tags.find((t) => t[0] === 'description')?.[1] ?? '',
      tags: tagValues,
      archivedForever: tags.find((t) => t[0] === 'archive-tier')?.[1] === 'forever',
      savedAt: Math.floor(Date.now() / 1000),
      curator,
      eventId: `private:${url}`
    };
  }

  async function exportNow() {
    error = '';
    status = 'fetching events…';
    working = true;
    try {
      const session = currentSession();
      if (!session.pubkey) throw new Error('Sign in to export.');
      const ndk = getNdk();

      // Public marks.
      const publicEvents = includePublic
        ? Array.from(await ndk.fetchEvents({
            kinds: [KIND.webBookmark as never],
            authors: [session.pubkey]
          }))
        : [];

      // Private set.
      let privateBookmarks: ParsedBookmark[] = [];
      let privateEvent: SignedEventLike | null = null;
      if (includePrivate) {
        const set = await fetchOwnPrivateSet(session.pubkey);
        privateBookmarks = set.entries.map((tags) =>
          bookmarkFromInnerTags(tags, session.pubkey!)
        );
        // For jsonl we need the raw event; refetch.
        if (format === 'jsonl') {
          privateEvent = (await ndk.fetchEvent({
            kinds: [KIND.privateBookmarkSet as never],
            authors: [session.pubkey],
            '#d': ['deepmarks-private']
          })) as unknown as SignedEventLike | null;
        }
      }

      const publicBookmarks = publicEvents
        .map((e) => parseBookmarkEvent(e as unknown as SignedEventLike))
        .filter((b): b is ParsedBookmark => b !== null);

      const all = [...publicBookmarks, ...privateBookmarks];

      let payload: string;
      let filename: string;
      let mime: string;

      if (format === 'jsonl') {
        const events: SignedEventLike[] = publicEvents.map((e) => ({
          id: e.id,
          pubkey: e.pubkey,
          kind: e.kind ?? 0,
          created_at: e.created_at ?? 0,
          tags: e.tags,
          content: e.content,
          sig: e.sig
        }));
        if (privateEvent) events.push(privateEvent);
        payload = generateJsonl(events);
        filename = `deepmarks-${Date.now()}.jsonl`;
        mime = 'application/jsonl';
      } else {
        const exporter = exporters.find((e) => e.id === format);
        if (!exporter) throw new Error(`Unknown format ${format}`);
        payload = exporter.generate(all);
        filename = `deepmarks-${Date.now()}.${exporter.extension}`;
        mime = exporter.mime;
      }

      downloadAsFile(payload, filename, mime);
      status = `downloaded ${all.length || publicEvents.length} bookmark${all.length === 1 ? '' : 's'} as ${filename}`;
    } catch (e) {
      error = (e as Error).message;
      status = '';
    } finally {
      working = false;
    }
  }
</script>

<svelte:head><title>export — Deepmarks</title></svelte:head>

<div class="page">
  <h1>export bookmarks</h1>
  <p class="lede">
    Your data, on demand. There is no lock-in to leave from. Encrypted private bookmarks are
    decrypted in the browser before export.
  </p>

  <section>
    <h2>format</h2>
    {#each exporters as e}
      <label>
        <input type="radio" bind:group={format} value={e.id} /> {e.label}
        <small>(.{e.extension})</small>
      </label>
    {/each}
    <label>
      <input type="radio" bind:group={format} value="jsonl" /> raw signed Nostr events
      <small>(.jsonl, lossless — re-publishable to any Nostr client)</small>
    </label>
  </section>

  <section>
    <h2>include</h2>
    <label><input type="checkbox" bind:checked={includePublic} /> public bookmarks (kind:39701)</label>
    <label><input type="checkbox" bind:checked={includePrivate} /> private bookmarks (kind:30003, decrypted)</label>
  </section>

  <button class="primary" type="button" on:click={exportNow} disabled={!$canSign || working || (!includePublic && !includePrivate)}>
    {working ? 'generating…' : 'generate export'}
  </button>

  {#if !$canSign}
    <p class="muted">Sign in to export your own bookmarks.</p>
  {/if}
  {#if status}<div class="status">{status}</div>{/if}
  {#if error}<div class="error">{error}</div>{/if}
</div>

<style>
  .page { max-width: 540px; margin: 0 auto; padding: 36px 24px 60px; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); letter-spacing: -0.4px; margin: 0 0 8px; }
  .lede { color: var(--ink); margin: 0 0 24px; line-height: 1.6; }
  section { margin-top: 28px; }
  section h2 { font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 1.5px; margin: 0 0 12px; padding-bottom: 6px; font-weight: 600; border-bottom: 1px solid var(--rule); }
  label { display: block; padding: 5px 0; cursor: pointer; font-size: 13px; }
  label small { color: var(--muted); margin-left: 4px; }
  .primary { margin-top: 24px; background: var(--coral); color: var(--on-coral); border: 0; padding: 10px 18px; border-radius: 100px; font-weight: 500; cursor: pointer; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .muted { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .status { margin-top: 16px; padding: 10px 14px; background: var(--archive-soft); color: var(--archive); border-radius: 8px; font-size: 13px; }
  .error { margin-top: 16px; padding: 10px 14px; background: var(--coral-soft); color: var(--coral-deep); border-radius: 8px; font-size: 13px; }
</style>
