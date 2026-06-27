<script lang="ts">
  // Textarea that opens an @-mention dropdown when the user types `@`
  // followed by characters that match a known contact. On selection
  // the typed `@partial` is replaced with `nostr:<npub>` — every
  // major Nostr client (Damus, Primal, Snort, Amethyst) renders that
  // as an inline profile pill, and the kind:1 builder turns each
  // npub URI into a `p` tag so the mentioned user gets notified.
  //
  // The contacts list is fetched once per session through the server-
  // side /account/contacts join (follows + profile cache), then
  // filtered locally per keystroke — no per-character network traffic.

  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import {
    contactsCache,
    ensureContacts,
    peekContacts,
    filterContacts,
    type ContactEntry,
  } from '$lib/stores/contacts-cache';

  export let value: string = '';
  export let placeholder: string = '';
  export let rows: number = 4;
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher<{ input: string }>();

  let textarea: HTMLTextAreaElement | undefined;
  let suggestions: ContactEntry[] = [];
  let activeIndex = 0;
  /** Index in `value` where the current `@` token begins. -1 = no
   *  mention in progress. */
  let mentionStart = -1;
  /** All contacts currently in the dropdown — bounded by filterContacts. */
  let allContacts: ContactEntry[] = peekContacts();

  // Subscribe to the contacts store so late-arriving data (the user
  // typed `@` while the fetch was in flight) re-evaluates the
  // current dropdown. Without this the dropdown stays empty even
  // after contacts arrive because nothing re-runs updateMention.
  const unsubscribeContacts = contactsCache.subscribe((state) => {
    allContacts = state.contacts;
    if (mentionStart >= 0) updateMention();
  });
  onDestroy(() => unsubscribeContacts());

  onMount(() => {
    // Kick the fetch on mount so the dropdown is ready by the time
    // the user types the first `@`. If contacts are already cached
    // from an earlier mount/session, this resolves synchronously
    // through the in-flight cache.
    if (allContacts.length === 0) {
      void ensureContacts().then((c) => { allContacts = c; });
    }
  });

  function onFocus(): void {
    if (allContacts.length === 0) {
      void ensureContacts().then((c) => { allContacts = c; });
    }
  }

  function onInput(): void {
    if (!textarea) return;
    value = textarea.value;
    dispatch('input', value);
    updateMention();
  }

  function updateMention(): void {
    if (!textarea) return;
    const caret = textarea.selectionStart;
    // Walk backwards from the caret to find the start of the current
    // @-token (if any). Stop at whitespace or string start.
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        // Token boundary: must be at string start OR preceded by whitespace
        if (i === 0 || /\s/.test(value[i - 1]!)) {
          mentionStart = i;
          const query = value.slice(i + 1, caret);
          // Cap the query length — if a user types past a reasonable
          // username we close the dropdown rather than do work.
          if (query.length > 40 || /\s/.test(query)) {
            mentionStart = -1;
            suggestions = [];
            return;
          }
          suggestions = filterContacts(query, allContacts);
          activeIndex = 0;
          return;
        }
        break;
      }
      if (/\s/.test(ch!)) break;
      i--;
    }
    mentionStart = -1;
    suggestions = [];
  }

  function select(contact: ContactEntry): void {
    if (!textarea || mentionStart < 0) return;
    const before = value.slice(0, mentionStart);
    const after = value.slice(textarea.selectionStart);
    const insertion = `nostr:${contact.npub} `;
    value = before + insertion + after;
    dispatch('input', value);
    mentionStart = -1;
    suggestions = [];
    void tick().then(() => {
      if (!textarea) return;
      const caret = before.length + insertion.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      select(suggestions[activeIndex]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      mentionStart = -1;
      suggestions = [];
    }
  }

  function displayLabel(c: ContactEntry): string {
    if (c.name) return c.name;
    try { return nip19.npubEncode(c.pubkey).slice(0, 12) + '…'; }
    catch { return c.pubkey.slice(0, 12) + '…'; }
  }
</script>

<div class="mention-wrap">
  <textarea
    bind:this={textarea}
    bind:value
    on:input={onInput}
    on:focus={onFocus}
    on:keydown={onKeydown}
    {placeholder}
    {rows}
    {disabled}
  ></textarea>
  {#if suggestions.length > 0}
    <ul class="dropdown" role="listbox">
      {#each suggestions as contact, i (contact.pubkey)}
        <li
          role="option"
          aria-selected={i === activeIndex}
          class:active={i === activeIndex}
          on:mousedown|preventDefault={() => select(contact)}
        >
          {#if contact.picture}
            <img src={contact.picture} alt="" loading="lazy" />
          {:else}
            <span class="avatar-fallback"></span>
          {/if}
          <span class="meta">
            <span class="name">{displayLabel(contact)}</span>
            {#if contact.nip05}<span class="nip05">{contact.nip05}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .mention-wrap {
    position: relative;
    width: 100%;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--paper);
    color: var(--ink-deep);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
  }
  textarea:focus {
    outline: none;
    border-color: var(--coral);
  }
  .dropdown {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    margin: 0;
    padding: 4px 0;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
    max-height: 260px;
    overflow-y: auto;
    z-index: 50;
  }
  .dropdown li {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
  }
  .dropdown li.active,
  .dropdown li:hover {
    background: var(--paper-warm);
  }
  .dropdown img,
  .avatar-fallback {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--rule);
    flex-shrink: 0;
    object-fit: cover;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: 13px;
    color: var(--ink-deep);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nip05 {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
