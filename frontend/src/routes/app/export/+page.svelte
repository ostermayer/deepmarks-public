<script lang="ts">
  import { exporters, downloadAsFile, generateJsonl, type ExportFormat } from '$lib/exporters';
  import {
    fetchOwnPrivateSetEvents,
    parsePrivateEntry,
    tryDecryptPrivateSet,
    type DecryptResult,
  } from '$lib/nostr/private-bookmarks';
  import { ndkEventAsSigned, parseBookmarkEvent, type ParsedBookmark, type SignedEventLike } from '$lib/nostr/bookmarks';
  import {
    BOOKMARK_LIST_KINDS,
    extractImportedNoteRefs,
    extractImportedUrls,
    isValidNip51PrivateTags,
    tryDecryptNip51PrivateTags,
  } from '$lib/nostr/imported-bookmarks';
  import { nostrNoteArchiveUrl } from '$lib/nostr/social-refs';
  import { getNdk } from '$lib/nostr/ndk';
  import { KIND } from '$lib/nostr/kinds';
  import { canSign, currentSession } from '$lib/stores/session';

  let format: ExportFormat['id'] | 'jsonl' = 'netscape';
  let includePublic = true;
  let includePrivate = true;
  let includeImported = true;
  let working = false;
  let status = '';
  let error = '';

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
      let privateEvents: SignedEventLike[] = [];
      if (includePrivate) {
        privateEvents = await fetchOwnPrivateSetEvents(session.pubkey);
        privateBookmarks = await decryptPrivateBookmarksForExport(privateEvents, session.pubkey);
      }

      const publicBookmarks = publicEvents
        .map((e) => parseBookmarkEvent(ndkEventAsSigned(e)))
        .filter((b): b is ParsedBookmark => b !== null);

      // Bookmarks imported from OTHER Nostr clients' NIP-51 lists
      // (Amethyst/Primal/nostrudel…): URL entries plus bookmarked
      // posts, the latter exported as their social URL so any
      // bookmark manager can round-trip them.
      const importedBookmarks = includeImported
        ? await fetchImportedBookmarksForExport(session.pubkey)
        : [];

      const seen = new Set([...publicBookmarks, ...privateBookmarks].map((b) => b.url));
      const all = [
        ...publicBookmarks,
        ...privateBookmarks,
        ...importedBookmarks.filter((b) => !seen.has(b.url)),
      ];

      let payload: string;
      let filename: string;
      let mime: string;

      if (format === 'jsonl') {
        const events: SignedEventLike[] = publicEvents.map((e) => ndkEventAsSigned(e));
        events.push(...privateEvents);
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

  async function fetchImportedBookmarksForExport(pubkey: string): Promise<ParsedBookmark[]> {
    const ndk = getNdk();
    const events = Array.from(await ndk.fetchEvents({
      kinds: [...BOOKMARK_LIST_KINDS] as never[],
      authors: [pubkey],
    }));
    const out: ParsedBookmark[] = [];
    const seenUrls = new Set<string>();
    for (const raw of events) {
      const event = ndkEventAsSigned(raw);
      const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
      if (d.startsWith('deepmarks-')) continue; // our own sets export above
      const tagSets: Array<{ tags: string[][]; visibility: 'public' | 'private' }> = [
        { tags: event.tags, visibility: 'public' },
      ];
      // Encrypted list payloads (private bookmarks in other clients)
      // export too when the signer can decrypt them; failures are
      // skipped rather than blocking the export.
      try {
        const decrypted = await tryDecryptNip51PrivateTags(event, pubkey);
        if (decrypted.ok && isValidNip51PrivateTags(decrypted.tags)) {
          tagSets.push({ tags: decrypted.tags, visibility: 'private' });
        }
      } catch { /* skip undecryptable third-party payloads */ }
      for (const { tags, visibility } of tagSets) {
        for (const bookmark of extractImportedUrls(event, tags, visibility)) {
          if (seenUrls.has(bookmark.url)) continue;
          seenUrls.add(bookmark.url);
          out.push(bookmark);
        }
        for (const note of extractImportedNoteRefs(event, tags, visibility)) {
          const url = nostrNoteArchiveUrl(note.targetEventId);
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          out.push({
            url,
            title: 'Nostr post',
            description: '',
            tags: [],
            archivedForever: false,
            savedAt: note.savedAt,
            curator: pubkey,
            eventId: `nip51-note:${note.listEventId}:${note.targetEventId}`,
          } as ParsedBookmark);
        }
      }
    }
    return out;
  }

  async function decryptPrivateBookmarksForExport(
    events: SignedEventLike[],
    pubkey: string,
  ): Promise<ParsedBookmark[]> {
    const bookmarks: ParsedBookmark[] = [];
    for (const event of events) {
      const result = await tryDecryptPrivateSet(event, pubkey);
      if (!result.ok) throw new Error(privateExportError(result));
      for (const entry of result.set.entries) {
        const bookmark = parsePrivateEntry(entry, pubkey, event.created_at, event.id);
        if (bookmark) bookmarks.push(bookmark);
      }
    }
    return bookmarks;
  }

  function privateExportError(result: Extract<DecryptResult, { ok: false }>): string {
    switch (result.reason) {
      case 'no-signer':
        return 'Reconnect your signer to decrypt private bookmarks before export.';
      case 'wrong-key':
        return 'Could not decrypt a private bookmark set with this signer. Sign in with the same key that saved those bookmarks.';
      case 'corrupt-json':
      case 'wrong-shape':
        return 'A private bookmark set could not be parsed safely, so export stopped instead of creating an incomplete backup.';
      case 'no-event':
      default:
        return 'No private bookmark set was available to export.';
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
    <label><input type="checkbox" bind:checked={includeImported} /> imported from other Nostr clients (NIP-51 lists, incl. bookmarked posts)</label>
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
