<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import AppBookmarksView from '$lib/components/AppBookmarksView.svelte';

  onMount(() => {
    void goto('/app/bookmarks', { replaceState: true });
  });
</script>

<AppBookmarksView />
