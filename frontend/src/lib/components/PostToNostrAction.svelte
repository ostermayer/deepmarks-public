<script lang="ts">
  import { Send } from 'lucide-svelte';
  import { nip19 } from 'nostr-tools';
  import type { ParsedBookmark } from '$lib/nostr/bookmarks';
  import { canSign, session } from '$lib/stores/session';
  import { buildSocialPostEvent, defaultSocialPostText } from '$lib/nostr/social-post';
  import { publishEvent } from '$lib/nostr/publish';
  import { KIND } from '$lib/nostr/kinds';
  import MentionTextarea from './MentionTextarea.svelte';

  export let bookmark: ParsedBookmark;

  let open = false;
  let text = '';
  let posting = false;
  let message = '';
  let error = '';
  let signerPrompt = '';

  $: isPrivateBookmark = bookmark.eventId.startsWith('private:');
  $: showAction = !!$session.pubkey && (!isPrivateBookmark || $session.pubkey === bookmark.curator);
  $: defaultText = defaultSocialPostText({
    url: bookmark.url,
    title: bookmark.title,
    description: bookmark.description,
  });

  function openComposer() {
    if (!$canSign) return;
    text = defaultText;
    message = '';
    error = '';
    open = true;
  }

  function close() {
    if (posting) return;
    open = false;
    message = '';
    error = '';
  }

  function shareNaddrUrl(): string {
    if (isPrivateBookmark) return bookmark.url;
    try {
      const naddr = nip19.naddrEncode({
        kind: KIND.webBookmark,
        pubkey: bookmark.curator,
        identifier: bookmark.url,
      });
      return `https://njump.me/${naddr}`;
    } catch {
      return bookmark.url;
    }
  }

  async function copyNostrLink(): Promise<void> {
    const url = shareNaddrUrl();
    try {
      await navigator.clipboard.writeText(url);
      message = isPrivateBookmark ? 'URL copied' : 'Nostr bookmark link copied';
      error = '';
    } catch {
      message = url;
      error = '';
    }
  }

  async function publishPost(): Promise<void> {
    if (!$canSign || !$session.pubkey) {
      error = 'Connect your signer to post.';
      return;
    }
    if (!text.trim()) {
      error = 'Post text cannot be empty.';
      return;
    }

    posting = true;
    error = '';
    message = '';
    signerPrompt = $session.signer?.kind === 'nip07'
      ? 'Approve this Nostr post in your browser extension if it asks.'
      : '';
    try {
      const result = await publishEvent(
        buildSocialPostEvent({
          url: bookmark.url,
          title: bookmark.title,
          description: bookmark.description,
          content: text,
          bookmarkEventId: isPrivateBookmark ? undefined : bookmark.eventId,
          bookmarkAuthor: isPrivateBookmark ? undefined : bookmark.curator,
        }),
        $session.pubkey,
      );
      if (result.relays.length === 0) {
        message = 'post signed, but no relay accepted it yet';
      } else {
        message = `posted to ${result.relays.length} relay${result.relays.length === 1 ? '' : 's'}`;
        setTimeout(() => {
          open = false;
          message = '';
        }, 900);
      }
    } catch (e) {
      error = (e as Error).message ?? 'post failed';
    } finally {
      posting = false;
      signerPrompt = '';
    }
  }
</script>

{#if showAction}
  <button
    type="button"
    class="post-action"
    class:disabled={!$canSign}
    disabled={!$canSign}
    title={$canSign ? 'share this bookmark on Nostr' : 'connect your signer to share'}
    on:click|stopPropagation={openComposer}
  >
    <Send size={12} strokeWidth={2.2} />
    <span>share</span>
  </button>
{/if}

{#if showAction && open}
  <div class="post-backdrop" role="presentation" on:click={close}></div>
  <div
    class="post-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="post-title"
    tabindex="-1"
  >
    <h3 id="post-title">post to Nostr</h3>
    <p class="post-note">
      This publishes a public Nostr note from your account.
      {#if isPrivateBookmark}Your private save stays private, but this note will reveal the link.{/if}
    </p>
    <MentionTextarea
      rows={7}
      bind:value={text}
      disabled={posting}
      placeholder="type @ to mention a contact"
    />
    {#if error}<div class="post-error">{error}</div>{/if}
    {#if signerPrompt}<div class="post-prompt" aria-live="polite">{signerPrompt}</div>{/if}
    {#if message}<div class="post-message">{message}</div>{/if}
    <div class="post-actions">
      <button type="button" class="secondary" on:click={() => void copyNostrLink()} disabled={posting}>
        copy link
      </button>
      <span class="spacer"></span>
      <button type="button" class="ghost" on:click={close} disabled={posting}>cancel</button>
      <button type="button" class="primary" on:click={() => void publishPost()} disabled={posting || !text.trim()}>
        {posting ? 'posting...' : 'post'}
      </button>
    </div>
  </div>
{/if}

<style>
  .post-action {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    align-self: center;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    line-height: 1.2;
  }
  .post-action:hover:not(:disabled) {
    color: var(--coral);
  }
  .post-action.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .post-action :global(svg) {
    flex: 0 0 auto;
  }
  .post-backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(4, 18, 32, 0.28);
  }
  .post-dialog {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 121;
    width: min(560px, calc(100vw - 28px));
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(3, 18, 32, 0.28);
    padding: 18px;
    color: var(--ink);
  }
  .post-dialog h3 {
    margin: 0 0 6px;
    color: var(--ink-deep);
    font-size: 18px;
    font-weight: 650;
  }
  .post-note {
    margin: 0 0 12px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
  }
  .post-dialog textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    resize: vertical;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    line-height: 1.45;
  }
  .post-dialog textarea:focus {
    outline: 2px solid var(--coral-soft);
    border-color: var(--coral);
  }
  .post-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .post-actions button {
    border-radius: 6px;
    border: 1px solid var(--rule);
    padding: 7px 12px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .post-actions button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .post-actions .primary {
    border-color: var(--coral);
    background: var(--coral);
    color: var(--on-coral);
    font-weight: 600;
  }
  .post-actions .primary:hover:not(:disabled) {
    background: var(--coral-deep);
  }
  .post-actions .ghost,
  .post-actions .secondary {
    background: var(--surface);
    color: var(--ink);
  }
  .post-actions .ghost:hover:not(:disabled),
  .post-actions .secondary:hover:not(:disabled) {
    border-color: var(--coral);
    color: var(--coral);
  }
  .post-error,
  .post-message {
    margin-top: 8px;
    font-size: 13px;
  }
  .post-error {
    color: var(--coral-deep);
  }
  .post-message {
    color: var(--archive);
  }
  .post-prompt {
    margin-top: 8px;
    color: var(--ink-deep);
    background: var(--surface);
    border-left: 3px solid var(--link);
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
  }
  @media (max-width: 520px) {
    .post-actions {
      flex-wrap: wrap;
    }
    .spacer {
      display: none;
    }
    .post-actions button {
      flex: 1 1 auto;
    }
  }
</style>
