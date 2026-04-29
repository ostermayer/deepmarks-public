<script lang="ts">
  // Chip-style tag input. Each committed tag is a single lowercase token
  // (letters/digits plus . and -); typed spaces/commas/Enter commit the
  // current draft. Backspace on an empty draft removes the last chip.
  //
  // Two-way bound to `tags: string[]` so the host form can submit directly.
  // Suggestions are rendered as a dimmer row beneath the input; clicking
  // one appends it to the list.

  import { createEventDispatcher } from 'svelte';

  export let tags: string[] = [];
  export let suggestions: string[] = [];
  export let placeholder = 'add tags';
  export let maxTags = 30;

  const dispatch = createEventDispatcher<{ change: { tags: string[] } }>();

  let draft = '';
  let inputEl: HTMLInputElement;

  // Allowed: a-z 0-9 . - . Uppercase is downcased. Anything else is treated
  // as a separator and splits the current draft into (possibly multiple)
  // committed chips.
  function normalize(raw: string): string[] {
    const lowered = raw.toLowerCase();
    const cleaned = lowered.replace(/[^a-z0-9.\-]+/g, ' ').trim();
    if (!cleaned) return [];
    return cleaned
      .split(/\s+/)
      .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
      .filter((t) => t && t.length <= 40);
  }

  function commitDraft(): boolean {
    const newTags = normalize(draft);
    draft = '';
    if (newTags.length === 0) return false;
    let added = false;
    for (const t of newTags) {
      if (tags.includes(t)) continue;
      if (tags.length >= maxTags) break;
      tags = [...tags, t];
      added = true;
    }
    if (added) dispatch('change', { tags });
    return added;
  }

  function removeTag(tag: string) {
    tags = tags.filter((t) => t !== tag);
    dispatch('change', { tags });
  }

  function addSuggestion(tag: string) {
    if (tags.includes(tag)) return;
    if (tags.length >= maxTags) return;
    tags = [...tags, tag];
    dispatch('change', { tags });
    inputEl?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) {
        e.preventDefault();
        commitDraft();
      } else if (e.key === 'Enter') {
        // Let Enter bubble so the parent form can submit when empty.
      }
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      // Peel off the last chip back into the draft so the user can edit it.
      const last = tags[tags.length - 1]!;
      tags = tags.slice(0, -1);
      draft = last;
      dispatch('change', { tags });
    }
  }

  function onBlur() {
    if (draft.trim()) commitDraft();
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    // If the pasted text is a plain single token, let the default
    // handler fill the draft; otherwise intercept and split-commit.
    if (/[\s,;|]/.test(text)) {
      e.preventDefault();
      draft = text;
      commitDraft();
    }
  }

  $: visibleSuggestions = suggestions.filter((s) => !tags.includes(s));
</script>

<div class="chip-input">
  <div class="chips-row" on:click={() => inputEl?.focus()} role="presentation">
    {#each tags as tag (tag)}
      <button
        type="button"
        class="chip"
        on:click|stopPropagation={() => removeTag(tag)}
        aria-label={`remove tag ${tag}`}
      >
        <span>{tag}</span>
        <span class="x">×</span>
      </button>
    {/each}
    <input
      type="text"
      bind:this={inputEl}
      bind:value={draft}
      on:keydown={onKeydown}
      on:blur={onBlur}
      on:paste={onPaste}
      placeholder={tags.length === 0 ? placeholder : ''}
    />
  </div>
  {#if visibleSuggestions.length > 0}
    <div class="suggestions">
      <span class="label">suggested:</span>
      {#each visibleSuggestions as s (s)}
        <button
          type="button"
          class="suggestion"
          on:click={() => addSuggestion(s)}
          aria-label={`add tag ${s}`}
        >+ {s}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .chip-input {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-height: 28px;
    padding: 4px 6px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    cursor: text;
  }
  .chips-row:focus-within {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 11px;
    padding: 2px 4px 2px 8px;
    background: var(--coral-soft);
    color: var(--coral-deep);
    border: 0;
    border-radius: 100px;
    cursor: pointer;
  }
  .chip .x {
    font-size: 14px;
    line-height: 1;
    opacity: 0.7;
    padding: 0 4px;
  }
  .chip:hover .x { opacity: 1; }
  .chips-row input {
    flex: 1 1 120px;
    min-width: 80px;
    border: 0;
    outline: 0;
    background: transparent;
    font: inherit;
    font-size: 12px;
    padding: 3px 2px;
    color: var(--ink);
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: baseline;
    font-size: 11px;
  }
  .suggestions .label {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-right: 2px;
  }
  .suggestion {
    font: inherit;
    font-size: 11px;
    padding: 2px 8px;
    background: transparent;
    color: var(--muted);
    border: 1px dashed var(--rule);
    border-radius: 100px;
    cursor: pointer;
  }
  .suggestion:hover {
    color: var(--coral-deep);
    border-color: var(--coral-soft);
    background: var(--coral-soft);
  }
</style>
