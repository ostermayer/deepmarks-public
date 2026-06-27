<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AccountContact } from '$lib/api/client';
  import { getProfile, isLikelyImageUrl, type Profile } from '$lib/nostr/profiles';
  import Avatar from './Avatar.svelte';

  export let contact: AccountContact;
  export let checked = false;
  export let profileName: string | undefined = undefined;
  export let profileNip05: string | undefined = undefined;
  export let profilePicture: string | undefined = undefined;

  const dispatch = createEventDispatcher<{ toggle: { checked: boolean } }>();

  $: profile = getProfile(contact.pubkey);
  $: handle = handleFor(contact, $profile);
  $: address = addressFor(contact, $profile);
  $: parentPicture = isLikelyImageUrl(profilePicture) ? profilePicture : undefined;
  $: resolvedPicture = isLikelyImageUrl($profile?.picture) ? $profile?.picture : undefined;
  $: picture = isLikelyImageUrl(contact.picture) ? contact.picture : parentPicture || resolvedPicture;

  function handleFor(row: AccountContact, resolved: Profile | null): string {
    const clean = firstUsableHandle([
      profileName,
      row.name,
      resolved?.name,
      resolved?.displayName,
      row.deepmarksUsername,
      nameFromNip05(row.nip05 || profileNip05 || resolved?.nip05),
    ]);
    if (clean) return `@${clean}`;
    if (row.npub) return `@${row.npub.slice(0, 12)}...`;
    return `@${row.pubkey.slice(0, 8)}...`;
  }

  function addressFor(row: AccountContact, resolved: Profile | null): string {
    return row.nip05?.trim() || profileNip05?.trim() || resolved?.nip05?.trim() || '';
  }

  function nameFromNip05(nip05: string | undefined): string | undefined {
    const local = nip05?.split('@')[0]?.trim();
    return local || undefined;
  }

  function firstUsableHandle(values: Array<string | undefined>): string | undefined {
    for (const value of values) {
      const clean = cleanHandle(value);
      if (clean) return clean;
    }
    return undefined;
  }

  function cleanHandle(value: string | undefined): string | undefined {
    const clean = value?.trim().replace(/^@+/, '');
    if (!clean) return undefined;
    if (clean.toLowerCase() === 'profile') return undefined;
    return clean;
  }
</script>

<label class="contact-row">
  <input
    type="checkbox"
    {checked}
    on:change={(event) => dispatch('toggle', { checked: (event.currentTarget as HTMLInputElement).checked })}
  />
  <Avatar
    pubkey={contact.pubkey}
    size={28}
    label={handle}
    {picture}
    eagerProfile={false}
  />
  <span>
    <strong>{handle}</strong>
    {#if address}<small>{address}</small>{/if}
  </span>
</label>

<style>
  .contact-row {
    min-width: 0;
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: center;
    gap: 9px;
    padding: 8px;
    border: 1px solid var(--rule);
    background: var(--paper);
    cursor: pointer;
  }
  .contact-row input {
    width: 15px;
    height: 15px;
    accent-color: var(--coral);
  }
  .contact-row span {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .contact-row strong,
  .contact-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .contact-row strong {
    color: var(--ink);
    font-size: 13px;
  }
  .contact-row small {
    color: var(--muted);
    font-size: 11px;
    font-family: 'Courier New', monospace;
  }
</style>
