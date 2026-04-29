<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { session } from '$lib/stores/session';
  import { loadMuteList } from '$lib/nostr/mute-list';
  import { loadContactList } from '$lib/nostr/contacts';
  import { startMyArchivesLoader } from '$lib/stores/my-archives';
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
    wipeLegacyCachesOnce();
    void session.rehydrate();
    // Subscribe-once wiring: my-archives store stays warm across
    // every /app page so BookmarkCard's 'archived' indicator can
    // hover-thumbnail and click-open without a per-page fetch.
    return startMyArchivesLoader();
  });

  // Load mute list (kind:10000) + contact list (kind:3) on session
  // change. Mute store filters every feed; contact store powers
  // /app/follows. Both are writable Svelte stores that the rest of
  // the app subscribes to.
  $: if ($session.pubkey) {
    void loadMuteList($session.pubkey);
    void loadContactList($session.pubkey);
  }
</script>

<slot />
