<script lang="ts">
  // Danger zone: tombstone the account.
  //
  // Two things happen, in this order:
  //   1. Publish a NIP-09 kind:5 deletion covering every kind:0 / 10002 /
  //      10063 / 30003 / 39701 event we can find from the user's pubkey.
  //      The user's own signer authorizes this. Well-behaved relays (incl.
  //      our relay.deepmarks.org) drop the referenced events; we can't
  //      force it on relays we don't run.
  //   2. Call DELETE /account on payment-proxy to release the user's
  //      deepmarks handle + clear server-side state (api keys, private
  //      marks, account record). Lifetime-payment record stays, so the
  //      same nsec can start fresh later without re-paying.
  //
  // Confirmation requires typing "DELETE MY ACCOUNT" in all caps — a
  // deliberate speed bump. After success we sign the user out of this
  // browser.

  import { session, canSign } from '$lib/stores/session';
  import { api, ApiError } from '$lib/api/client';
  import { publishAccountDeletion } from '$lib/nostr/delete';

  const CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';

  let typed = '';
  let working = false;
  let step = '';
  let result: {
    foundEvents: number;
    deletionEventId: string | null;
    relays: string[];
    releasedUsername: string | null;
    revokedApiKeys: number;
    privateMarksRemoved: number;
  } | null = null;
  let error = '';

  $: armed = typed.trim() === CONFIRMATION_PHRASE && $canSign && !working;

  async function confirmDelete() {
    if (!armed) return;
    error = '';
    result = null;
    working = true;
    try {
      const pubkey = $session.pubkey;
      if (!pubkey) throw new Error('not signed in');

      step = 'publishing nostr deletion request…';
      const nostr = await publishAccountDeletion(pubkey);

      step = 'clearing server-side state…';
      const server = await api.account.delete();

      result = {
        foundEvents: nostr.foundEvents,
        deletionEventId: nostr.deletionEventId,
        relays: nostr.relays,
        releasedUsername: server.releasedUsername,
        revokedApiKeys: server.revokedApiKeys,
        privateMarksRemoved: server.privateMarksRemoved,
      };
      step = '';
      // Sign out after a beat so the user can see the receipt.
      setTimeout(() => session.logout(), 6_000);
    } catch (e) {
      error = e instanceof ApiError
        ? `server refused: ${e.message}`
        : (e as Error).message ?? 'unknown error';
      step = '';
    } finally {
      working = false;
    }
  }
</script>

<section class="danger-zone">
  <h2>delete account</h2>

  {#if result}
    <p class="ok">
      deletion request published to {result.relays.length} relay{result.relays.length === 1 ? '' : 's'}
      for {result.foundEvents} event{result.foundEvents === 1 ? '' : 's'}.
      {#if result.releasedUsername}your handle <code>{result.releasedUsername}</code> was released. {/if}
      signing you out…
    </p>
  {:else}
    <p class="explainer">
      this tombstones your deepmarks account and asks the nostr network to delete your public
      bookmarks, bookmark lists, profile, relay list, and blossom list. on our side we release
      your <strong>deepmarks handle</strong> (into the 30-day cooldown), revoke all api keys, and
      drop any cached private-bookmark ciphertexts.
    </p>
    <ul class="caveats">
      <li>
        <strong>nostr deletions are best-effort.</strong> well-behaved relays honor NIP-09 kind:5
        requests — our relay and our blossom server do — but any other relay that already has
        your events may keep them. copies someone else has saved are out of reach.
      </li>
      <li>
        your <strong>lifetime payment is preserved</strong>. if you sign back in with the same
        nsec you regain your paid tier without re-paying; a different nsec starts fresh.
      </li>
      <li>this can't be undone from the deepmarks side.</li>
    </ul>

    {#if !$canSign}
      <p class="explainer">
        {#if $session.pubkey}
          your signer isn't connected on this tab — nsec sessions aren't persisted for security.
          <a href="/login?redirect=/app/settings">sign in again</a> to confirm.
        {:else}
          connect your signer to confirm — we need it to sign the nostr deletion.
        {/if}
      </p>
    {:else}
      <label class="field">
        <span>type <code>{CONFIRMATION_PHRASE}</code> to confirm</span>
        <input
          type="text"
          bind:value={typed}
          placeholder={CONFIRMATION_PHRASE}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          disabled={working}
        />
      </label>
      <button
        type="button"
        class="destroy"
        on:click={confirmDelete}
        disabled={!armed}
      >
        {working ? 'deleting…' : 'delete my account'}
      </button>
      {#if step}<p class="step">{step}</p>{/if}
      {#if error}<p class="err">{error}</p>{/if}
    {/if}
  {/if}
</section>

<style>
  .danger-zone {
    margin-top: 40px;
    border: 1px solid #c44;
    border-radius: 8px;
    padding: 18px 20px;
    background: rgba(196, 68, 68, 0.04);
  }
  .danger-zone h2 {
    font-size: 11px;
    text-transform: uppercase;
    color: #a33;
    letter-spacing: 1.5px;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid #c44;
  }
  .explainer {
    color: var(--ink-deep);
    font-size: 13px;
    line-height: 1.55;
    margin: 0 0 12px;
  }
  .caveats {
    margin: 0 0 16px;
    padding-left: 20px;
    color: var(--ink-deep);
    font-size: 12px;
    line-height: 1.55;
  }
  .caveats li { margin-bottom: 6px; }
  .field {
    display: block;
    margin: 0 0 12px;
  }
  .field span {
    display: block;
    font-size: 12px;
    color: var(--ink-deep);
    margin-bottom: 4px;
  }
  .field input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    color: var(--ink-deep);
    font-family: 'Courier New', monospace;
    font-size: 13px;
    letter-spacing: 1px;
  }
  .field input:focus {
    outline: 2px solid #c44;
    border-color: #c44;
  }
  .destroy {
    background: #c44;
    color: #fff;
    border: 0;
    padding: 9px 20px;
    border-radius: 100px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .destroy:hover:not(:disabled) { background: #a33; }
  .destroy:disabled { opacity: 0.4; cursor: not-allowed; }
  .step { margin: 10px 0 0; color: var(--ink); font-size: 12px; }
  .err { margin: 10px 0 0; color: #a33; font-size: 12px; }
  .ok { color: var(--archive); font-size: 13px; line-height: 1.55; margin: 0; }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--paper-warm);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--ink-deep);
  }
</style>
