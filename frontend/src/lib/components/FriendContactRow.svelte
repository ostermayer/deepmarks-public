<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AccountContact } from '$lib/api/client';
  import { getProfile } from '$lib/nostr/profiles';
  import Avatar from './Avatar.svelte';

  export let contact: AccountContact;
  export let checked = false;

  const dispatch = createEventDispatcher<{ toggle: { checked: boolean } }>();

  $: profile = getProfile(contact.pubkey);
  $: handle = handleFor(contact);
  $: address = addressFor(contact);

  function handleFor(row: AccountContact): string {
    const raw = row.name
      || $profile?.name
      || $profile?.displayName
      || nameFromNip05(row.nip05 || $profile?.nip05)
      || row.deepmarksUsername;
    if (!raw) return '@profile';
    const clean = raw.trim().replace(/^@+/, '');
    return clean ? `@${clean}` : '@profile';
  }

  function addressFor(row: AccountContact): string {
    return row.nip05?.trim() || $profile?.nip05?.trim() || '';
  }

  function nameFromNip05(nip05: string | undefined): string | undefined {
    const local = nip05?.split('@')[0]?.trim();
    return local || undefined;
  }
</script>

<label class="contact-row">
  <input
    type="checkbox"
    {checked}
    on:change={(event) => dispatch('toggle', { checked: (event.currentTarget as HTMLInputElement).checked })}
  />
  <Avatar pubkey={contact.pubkey} size={28} label={handle} />
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
