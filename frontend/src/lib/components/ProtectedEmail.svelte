<script lang="ts">
  import { onMount } from 'svelte';

  export let label = 'email support';
  export let subject = '';

  const schemeCodes = [109, 97, 105, 108, 116, 111, 58];
  const addressCodes = [
    104, 101, 108, 108, 111, 64, 100, 101, 101, 112, 109, 97, 114, 107, 115, 46, 111, 114, 103,
  ];

  let mounted = false;

  onMount(() => { mounted = true; });

  function handleClick(event: MouseEvent): void {
    event.preventDefault();
    if (!mounted) return;
    const scheme = String.fromCharCode(...schemeCodes);
    const address = String.fromCharCode(...addressCodes);
    const qs = subject ? `?subject=${encodeURIComponent(subject)}` : '';
    window.location.href = `${scheme}${address}${qs}`;
  }
</script>

<a href="#contact" aria-label={label} on:click={handleClick}>{label}</a>

<style>
  a {
    color: var(--link);
  }
  a:hover {
    color: var(--coral);
  }
</style>
