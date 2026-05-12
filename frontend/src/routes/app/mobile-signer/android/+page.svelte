<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    completeNostrSignerRequest,
    getPendingNostrSignerRequest,
    rejectNostrSignerRequest,
    type PendingNostrSignerRequest,
  } from '$lib/mobile/secure-store';
  import { loadMobileSignerAccount } from '$lib/mobile/signer-account';
  import { executeMobileSignerMethod } from '$lib/mobile/nip46-service';

  let request: PendingNostrSignerRequest | null = null;
  let error = '';
  let working = false;

  $: requestId = $page.url.searchParams.get('request') ?? '';

  onMount(() => {
    void loadRequest();
  });

  async function loadRequest(): Promise<void> {
    request = await getPendingNostrSignerRequest();
    if (!request) {
      error = 'no pending Android signer request';
      return;
    }
    if (requestId && request.requestId !== requestId) {
      error = 'this Android signer request is no longer pending';
      request = null;
    }
  }

  async function approve(): Promise<void> {
    if (!request || working) return;
    working = true;
    error = '';
    try {
      const account = await loadMobileSignerAccount();
      if (!account) throw new Error('add your mobile signer key first');
      if (request.currentUser && request.currentUser !== account.pubkey) {
        throw new Error('request is for a different pubkey');
      }
      const { method, params } = requestToMethod(request);
      const rawResult = await executeMobileSignerMethod(method, params);
      const completion: { requestId: string; result: string; id?: string; event?: string } = {
        requestId: request.requestId,
        result: rawResult,
        id: request.id,
      };
      if (method === 'sign_event') {
        const signed = JSON.parse(rawResult) as { sig?: unknown };
        if (typeof signed.sig !== 'string') throw new Error('signed event is missing sig');
        completion.result = signed.sig;
        completion.event = rawResult;
      }
      await completeNostrSignerRequest(completion);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      working = false;
    }
  }

  async function reject(): Promise<void> {
    if (!request || working) return;
    working = true;
    await rejectNostrSignerRequest(request.requestId);
    void goto('/app/mobile-signer');
  }

  function requestToMethod(req: PendingNostrSignerRequest): { method: string; params: string[] } {
    switch (req.type) {
      case 'get_public_key':
        return { method: 'get_public_key', params: [] };
      case 'sign_event':
        return { method: 'sign_event', params: [req.content] };
      case 'nip04_encrypt':
      case 'nip04_decrypt':
      case 'nip44_encrypt':
      case 'nip44_decrypt':
        if (!req.pubkey) throw new Error(`${req.type} request is missing pubkey`);
        return { method: req.type, params: [req.pubkey, req.content] };
      default:
        throw new Error(`unsupported Android signer request: ${req.type}`);
    }
  }

  function previewContent(req: PendingNostrSignerRequest): string {
    if (req.type !== 'sign_event') return req.content || '(empty)';
    try {
      const event = JSON.parse(req.content) as { kind?: unknown; content?: unknown };
      const content = typeof event.content === 'string' ? event.content : '';
      return `kind ${String(event.kind ?? '?')}${content ? ` · ${content}` : ''}`;
    } catch {
      return req.content;
    }
  }
</script>

<svelte:head><title>Android signer request — Deepmarks</title></svelte:head>

<div class="page">
  <a class="back" href="/app/mobile-signer">← mobile signer</a>
  <h1>Android signer request</h1>

  {#if request}
    <section>
      <h2>{request.type}</h2>
      <p class="muted">Requested by an Android Nostr client through NIP-55.</p>
      <div class="details">
        {#if request.id}<span>id</span><code>{request.id}</code>{/if}
        {#if request.pubkey}<span>peer</span><code>{request.pubkey}</code>{/if}
        {#if request.currentUser}<span>user</span><code>{request.currentUser}</code>{/if}
        <span>content</span><code>{previewContent(request)}</code>
      </div>
      <div class="actions">
        <button class="primary" type="button" on:click={approve} disabled={working}>
          {working ? 'approving…' : 'approve'}
        </button>
        <button class="ghost" type="button" on:click={reject} disabled={working}>reject</button>
      </div>
    </section>
  {:else if !error}
    <p class="muted">loading request…</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .page { max-width: 680px; margin: 0 auto; padding: 36px 24px 72px; color: var(--ink-deep); }
  .back { color: var(--ink); font-size: 13px; text-decoration: none; }
  .back:hover { color: var(--coral); }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 30px; margin: 16px 0 24px; letter-spacing: 0; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0;
    border-bottom: 1px solid var(--rule); padding-bottom: 6px; margin: 0 0 12px;
  }
  .muted { color: var(--ink); font-size: 14px; line-height: 1.6; }
  .details {
    display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 8px 12px;
    border: 1px solid var(--rule); border-radius: 8px; padding: 12px;
  }
  .details span { color: var(--ink); font-size: 13px; }
  code { font-family: 'Courier New', monospace; font-size: 12px; color: var(--ink-deep); word-break: break-all; }
  .actions { display: flex; gap: 8px; margin-top: 14px; }
  .primary, .ghost { font-family: inherit; font-size: 13px; cursor: pointer; border-radius: 999px; padding: 9px 16px; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; }
  .ghost { background: transparent; color: var(--ink-deep); border: 1px solid var(--rule); }
  .primary:disabled, .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  .error {
    color: var(--coral-deep); background: var(--coral-soft); border-radius: 8px;
    padding: 9px 12px; font-size: 13px;
  }
</style>
