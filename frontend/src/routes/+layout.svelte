<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import MobileAppLockGate from '$lib/components/MobileAppLockGate.svelte';
  import NativePullRefresh from '$lib/components/NativePullRefresh.svelte';
  import { isNativeShell, nativePlatform } from '$lib/native/runtime';
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

  function lockNativeViewport(): () => void {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previous = viewport?.getAttribute('content') ?? null;
    viewport?.setAttribute(
      'content',
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
    );
    const preventGesture = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', preventGesture);
    document.addEventListener('gesturechange', preventGesture);
    document.addEventListener('gestureend', preventGesture);
    return () => {
      if (viewport) {
        if (previous === null) viewport.removeAttribute('content');
        else viewport.setAttribute('content', previous);
      }
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('gestureend', preventGesture);
    };
  }

  onMount(() => {
    const nativeShell = isNativeShell();
    const platform = nativePlatform();
    let unlockViewport: (() => void) | null = null;
    if (nativeShell) {
      document.documentElement.classList.add('native-shell', `native-${platform}`);
      document.body.classList.add('native-shell', `native-${platform}`);
      unlockViewport = lockNativeViewport();
    }
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
    // Web: when the user returns to the Deepmarks tab from another
    // tab/app, pull any bookmarks saved elsewhere (extension, mobile)
    // while we were hidden so the list reflects them on next paint.
    // Native handles its own equivalent in MobileAppLockGate via
    // Capacitor's appStateChange listener.
    let stopVisibilityListener: (() => void) | null = null;
    if (!nativeShell) {
      const onVisibility = (): void => {
        if (document.visibilityState !== 'visible') return;
        void import('$lib/stores/own-bookmarks').then(({ refreshOwnBookmarks }) => {
          refreshOwnBookmarks();
        }).catch(() => { /* tolerable */ });
      };
      document.addEventListener('visibilitychange', onVisibility);
      stopVisibilityListener = () => document.removeEventListener('visibilitychange', onVisibility);
    }
    // Background tick: every 90s, drain anything queued in the
    // durable publish queue. Lets a re-sync that staged thousands of
    // events make progress without the user having to do anything —
    // close the app, come back later, the queue will have shrunk.
    const drainTicker = window.setInterval(() => {
      void (async () => {
        const { currentSession } = await import('$lib/stores/session');
        const pubkey = currentSession().pubkey;
        if (!pubkey) return;
        const { drainPendingPublishes } = await import('$lib/nostr/pending-publish');
        await drainPendingPublishes(pubkey).catch(() => { /* per-item errors logged inside */ });
      })();
    }, 90_000);
    return () => {
      disposed = true;
      clearTimeout(startupTimer);
      clearTimeout(loaderTimer);
      if (sessionLoadTimer) clearTimeout(sessionLoadTimer);
      stopArchives?.();
      stopSaved?.();
      stopSessionLoads?.();
      stopDeepLinks?.();
      stopVisibilityListener?.();
      clearInterval(drainTicker);
      if (nativeShell) {
        unlockViewport?.();
        document.documentElement.classList.remove('native-shell', `native-${platform}`);
        document.body.classList.remove('native-shell', `native-${platform}`);
      }
    };
  });
</script>

<slot />
<NativePullRefresh />
<MobileAppLockGate />
