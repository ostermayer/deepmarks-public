<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { getProfile } from '$lib/nostr/profiles';

  export let pubkey = '';
  export let href = '';

  $: profile = getProfile(pubkey);
  $: npub = safeNpub(pubkey);
  $: label = $profile?.name || $profile?.displayName || shortNpub(npub) || 'profile';

  function safeNpub(pk: string): string {
    try { return nip19.npubEncode(pk); }
    catch { return ''; }
  }

  function shortNpub(value: string): string {
    return value ? `${value.slice(0, 10)}...` : '';
  }
</script>

<a class="nostr-ref profile" {href} title={npub || pubkey} on:click|stopPropagation>@{label}</a>

<style>
  .nostr-ref {
    color: var(--link);
    font-weight: 600;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .nostr-ref:hover {
    color: var(--coral);
    text-decoration: underline;
  }
</style>
