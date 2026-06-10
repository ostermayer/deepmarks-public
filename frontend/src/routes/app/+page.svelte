<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { currentSession } from '$lib/stores/session';

  // /app is just a redirect target. The previous implementation also
  // rendered AppBookmarksView in the meantime as a "preview while we
  // navigate", which flashed the previous session's cached bookmarks
  // on signed-out users between logout and the /login redirect. Render
  // nothing visible — the /app/+layout's enforceSession owns the
  // signed-out → /login redirect, and the onMount redirect below
  // owns the signed-in → /app/bookmarks redirect.
  onMount(() => {
    const next = currentSession().pubkey ? '/app/bookmarks' : '/login?redirect=%2Fapp%2Fbookmarks';
    void goto(next, { replaceState: true });
  });
</script>
