<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { session } from '$lib/stores/session';
  import { browser } from '$app/environment';

  /** One-time migration: drop hand-rolled localStorage caches now
   *  superseded by NDK's Dexie adapter. Keeps the storage tidy for
   *  users who installed before the cache adapter shipped — without
   *  this, orphaned blobs squat in localStorage indefinitely. The
   *  marker key prevents re-running on every page load. */
  function wipeLegacyCachesOnce(): void {
    if (!browser) return;
    const MARKER = 'deepmarks-cache-migration-v1';
    try {
      if (localStorage.getItem(MARKER) === '1') return;
      const prefixes = [
        'deepmarks-feed-cache:v1:',
        'deepmarks-private-bookmarks-cache:v1:',
        'deepmarks-profile:v2:',
      ];
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (prefixes.some((p) => k.startsWith(p))) localStorage.removeItem(k);
      }
      localStorage.setItem(MARKER, '1');
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  onMount(() => {
    document.getElementById('boot-shell')?.remove();
    let stopArchives: (() => void) | null = null;
    let stopSaved: (() => void) | null = null;
    let stopSessionLoads: (() => void) | null = null;
    let sessionLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let stopDeepLinks: (() => void) | null = null;
    let disposed = false;
    const startupTimer = setTimeout(() => {
      wipeLegacyCachesOnce();
      void session.rehydrate();
    }, 0);
    const loaderTimer = setTimeout(async () => {
      const [
        archivesModule,
        savedUrlsModule,
        contactsModule,
        deepLinksModule,
        mobileSignerModule,
      ] = await Promise.all([
        import('$lib/stores/my-archives'),
        import('$lib/stores/my-saved-urls'),
        import('$lib/nostr/contacts'),
        import('$lib/native/deep-links'),
        import('$lib/mobile/nip46-service'),
      ]);
      if (disposed) return;
      // Subscribe-once wiring: my-archives store stays warm across
      // every /app page so BookmarkCard's 'archived' indicator can
      // hover-thumbnail and click-open without a per-page fetch.
      stopArchives = archivesModule.startMyArchivesLoader();
      // 'saved' state on feed rows (search, recent, popular) — flips
      // the per-row save button to a 'saved ✓' label when the URL is
      // already on the user's bookmark list.
      stopSaved = savedUrlsModule.startMySavedUrlsLoader();
      // Load contact list (kind:3) after the shell has painted. It hits
      // NDK, so it should never block
      // the first render of /app/bookmarks.
      stopSessionLoads = session.subscribe(($session) => {
        if (sessionLoadTimer) clearTimeout(sessionLoadTimer);
        if (!$session.pubkey) return;
        const pubkey = $session.pubkey;
        sessionLoadTimer = setTimeout(() => {
          void contactsModule.loadContactList(pubkey);
        }, 0);
      });
      // Capacitor deep-link handler — no-op on web, routes
      // deepmarks://save?url=… to /app/save inside the native app.
      void deepLinksModule.setupDeepLinks().then((cleanup) => {
        if (disposed) cleanup();
        else stopDeepLinks = cleanup;
      });
      void mobileSignerModule.startMobileSignerInNativeShell();
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(startupTimer);
      clearTimeout(loaderTimer);
      if (sessionLoadTimer) clearTimeout(sessionLoadTimer);
      stopArchives?.();
      stopSaved?.();
      stopSessionLoads?.();
      stopDeepLinks?.();
    };
  });
</script>

<slot />
