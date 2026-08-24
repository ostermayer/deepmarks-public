<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { BadgeCheck, Shield, ThumbsUp } from 'lucide-svelte';
  import Avatar from '$lib/components/Avatar.svelte';
  import {
    completeNostrSignerRequest,
    getPendingNostrSignerRequest,
    rejectNostrSignerRequest,
    setNostrSignerTrust,
    type PendingNostrSignerRequest,
  } from '$lib/mobile/secure-store';
  import {
    loadMobileSignerAccount,
    type MobileSignerAccount,
  } from '$lib/mobile/signer-account';
  import { executeMobileSignerMethod } from '$lib/mobile/nip46-service';

  type AndroidTrustLevel = 'full' | 'medium' | 'low';
  type ApprovalTab = 'login' | 'permissions';

  let request: PendingNostrSignerRequest | null = null;
  let account: MobileSignerAccount | null = null;
  let error = '';
  let working = false;
  let activeTab: ApprovalTab = 'login';
  let selectedTrustLevel: AndroidTrustLevel = 'medium';
  let savedTrustLevel: AndroidTrustLevel | null = null;
  let trustReviewed = false;
  let mounted = false;
  let loadedRequestKey = '';
  let autoApprovalRequestId = '';

  const TRUST_STORAGE_PREFIX = 'deepmarks-android-signer-trust:v5:';

  const trustOptions: Array<{
    level: AndroidTrustLevel;
    title: string;
    description: string;
    icon: typeof BadgeCheck;
  }> = [
    { level: 'full', title: 'Full Trust', description: 'Sign every request from this app.', icon: BadgeCheck },
    { level: 'medium', title: 'Medium Trust', description: 'Auto-approve login and common auth requests.', icon: ThumbsUp },
    { level: 'low', title: 'Low Trust', description: 'Ask before each request.', icon: Shield },
  ];

  $: requestId = $page.url.searchParams.get('request') ?? '';
  $: requesterName = request?.requesterName || request?.requesterPackage || 'Nostr app';
  $: requesterPackage = request?.requesterPackage || '';
  $: requesterInitial = requesterName.slice(0, 1).toUpperCase() || 'N';
  $: accountNpub = account ? npubFor(account.pubkey) : '';
  $: requestedPubkey = normalizePubkey(request?.currentUser);
  $: requestedNpub = requestedPubkey ? npubFor(requestedPubkey) : '';
  $: accountMismatch = Boolean(account && requestedPubkey && requestedPubkey !== account.pubkey);
  $: approveDisabled = working || !account || accountMismatch;
  $: requestLabel = request ? labelForRequest(request) : '';
  $: needsTrustReview = Boolean(request?.type === 'get_public_key' && !savedTrustLevel && !trustReviewed);
  $: approveLabel = working
    ? 'approving...'
    : needsTrustReview
      ? 'review permissions'
      : activeTab === 'permissions'
        ? `approve with ${trustTitle(selectedTrustLevel)}`
        : request?.type === 'get_public_key'
          ? 'approve login'
          : 'approve request';
  $: if (
    mounted &&
    request &&
    account &&
    savedTrustLevel &&
    !working &&
    !accountMismatch &&
    autoApprovalRequestId !== request.requestId &&
    shouldAutoApprove(request, savedTrustLevel)
  ) {
    autoApprovalRequestId = request.requestId;
    void approve({ trustLevel: savedTrustLevel });
  }
  $: if (mounted) {
    const nextRequestKey = requestId || 'latest';
    if (nextRequestKey !== loadedRequestKey) {
      loadedRequestKey = nextRequestKey;
      void loadRequest(requestId);
    }
  }

  onMount(() => {
    mounted = true;
  });

  async function loadRequest(expectedRequestId = ''): Promise<void> {
    error = '';
    const [pendingRequest, signerAccount] = await Promise.all([
      getPendingNostrSignerRequest(),
      loadMobileSignerAccount(),
    ]);
    if (expectedRequestId !== requestId) return;
    if (!pendingRequest) {
      request = null;
      account = signerAccount;
      error = expectedRequestId ? 'request completed; return to Amethyst' : 'no pending Android signer request';
      return;
    }
    applyPendingRequest(pendingRequest, signerAccount);
    if (expectedRequestId && pendingRequest.requestId !== expectedRequestId) {
      routeToRequest(pendingRequest.requestId);
    }
  }

  function applyPendingRequest(pendingRequest: PendingNostrSignerRequest, signerAccount: MobileSignerAccount | null): void {
    request = pendingRequest;
    account = signerAccount;
    const savedTrust = loadSavedTrustLevel(pendingRequest);
    savedTrustLevel = savedTrust;
    selectedTrustLevel = savedTrust ?? 'medium';
    const willAutoApprove = Boolean(savedTrust && shouldAutoApprove(pendingRequest, savedTrust));
    activeTab = pendingRequest.type === 'get_public_key' || willAutoApprove ? 'login' : 'permissions';
    trustReviewed = activeTab === 'permissions' && !savedTrust;
  }

  function routeToRequest(requestId: string): void {
    void goto(`/app/mobile-signer/android?request=${encodeURIComponent(requestId)}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }

  function showTab(tab: ApprovalTab): void {
    activeTab = tab;
    if (tab === 'permissions') trustReviewed = true;
  }

  function selectTrustLevel(level: AndroidTrustLevel): void {
    selectedTrustLevel = level;
    trustReviewed = true;
  }

  async function approve(options: { trustLevel?: AndroidTrustLevel; reviewed?: boolean } = {}): Promise<void> {
    if (!request || working) return;
    if (needsTrustReview && !options.reviewed) {
      showTab('permissions');
      return;
    }
    working = true;
    error = '';
    try {
      const signerAccount = account ?? await loadMobileSignerAccount();
      if (!signerAccount) throw new Error('add your mobile signer key first');
      const requested = normalizePubkey(request.currentUser);
      if (requested && requested !== signerAccount.pubkey) {
        throw new Error('request is for a different pubkey');
      }
      const { method, params } = requestToMethod(request);
      const trustLevel = options.trustLevel ?? selectedTrustLevel;
      const shouldPersistTrust = trustReviewed || options.reviewed || Boolean(options.trustLevel);
      const rawResult = await executeMobileSignerMethod(method, params);
      if (shouldPersistTrust) await saveTrustLevel(request, trustLevel);
      const completion: { requestId: string; result: string; id?: string; event?: string } = {
        requestId: request.requestId,
        result: rawResult,
        id: request.id,
      };
      if (method === 'sign_event') {
        const signed = JSON.parse(rawResult) as { sig?: unknown };
        if (typeof signed.sig !== 'string') throw new Error('signed event is missing sig');
        completion.result = request.returnType === 'event' ? rawResult : signed.sig;
        completion.event = rawResult;
      }
      await completeNostrSignerRequest(completion);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      working = false;
    }
  }

  function shouldAutoApprove(req: PendingNostrSignerRequest, trustLevel: AndroidTrustLevel): boolean {
    if (trustLevel === 'low') return false;
    if (trustLevel === 'full') return true;
    return req.type === 'get_public_key' || isCommonAuthEvent(req);
  }

  function trustTitle(level: AndroidTrustLevel): string {
    if (level === 'full') return 'Full Trust';
    if (level === 'medium') return 'Medium Trust';
    return 'Low Trust';
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
      case 'decrypt_zap_event':
        return { method: 'decrypt_zap_event', params: [req.content] };
      default:
        throw new Error(`unsupported Android signer request: ${req.type}`);
    }
  }

  function labelForRequest(req: PendingNostrSignerRequest): string {
    if (req.type === 'get_public_key') return 'Login to this account';
    if (req.type === 'decrypt_zap_event') return 'Decrypt private zap';
    if (req.type === 'sign_event') {
      const kind = signEventKind(req);
      return kind === null ? 'Sign event' : `Sign kind ${kind} event`;
    }
    if (req.type.includes('decrypt')) return 'Decrypt content';
    if (req.type.includes('encrypt')) return 'Encrypt content';
    return req.type.replace(/_/g, ' ');
  }

  function signEventKind(req: PendingNostrSignerRequest): number | null {
    if (req.type !== 'sign_event') return null;
    try {
      const parsed = JSON.parse(req.content) as { kind?: unknown };
      return typeof parsed.kind === 'number' ? parsed.kind : null;
    } catch {
      return null;
    }
  }

  function isCommonAuthEvent(req: PendingNostrSignerRequest): boolean {
    const kind = signEventKind(req);
    return kind === 22242 || kind === 27235;
  }

  function trustStorageKey(req: PendingNostrSignerRequest): string {
    return `${TRUST_STORAGE_PREFIX}${req.requesterPackage || req.requesterName || 'unknown'}`;
  }

  function loadSavedTrustLevel(req: PendingNostrSignerRequest): AndroidTrustLevel | null {
    try {
      const value = localStorage.getItem(trustStorageKey(req));
      return parseStoredTrustLevel(value);
    } catch {
      return null;
    }
  }

  async function saveTrustLevel(req: PendingNostrSignerRequest, level: AndroidTrustLevel): Promise<void> {
    const appId = req.requesterPackage || req.requesterName || 'unknown';
    await setNostrSignerTrust({
      appId,
      level,
      requesterName: req.requesterName || '',
    });
    try {
      localStorage.setItem(trustStorageKey(req), JSON.stringify({
        level,
        requesterPackage: req.requesterPackage || '',
        requesterName: req.requesterName || '',
        updatedAt: new Date().toISOString(),
      }));
    } catch {
      // Trust preferences are convenience only; the explicit approval still succeeds.
    }
  }

  function parseStoredTrustLevel(value: string | null): AndroidTrustLevel | null {
    if (value === 'full' || value === 'medium' || value === 'low') return value;
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as { level?: unknown };
      const level = parsed.level;
      return level === 'full' || level === 'medium' || level === 'low' ? level : null;
    } catch {
      return null;
    }
  }

  function normalizePubkey(value: string | undefined): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) return '';
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
    if (!trimmed.toLowerCase().startsWith('npub1')) return '';
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== 'npub' || typeof decoded.data !== 'string') return '';
      return decoded.data.toLowerCase();
    } catch {
      return '';
    }
  }

  function npubFor(pubkey: string): string {
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return pubkey;
    }
  }

  function shortKey(value: string): string {
    return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
  }

  function previewContent(req: PendingNostrSignerRequest): string {
    if (req.type === 'get_public_key') return 'public key request';
    if (req.type === 'decrypt_zap_event') return 'private zap decryption request';
    if (req.type !== 'sign_event') return req.content || '(empty)';
    try {
      const event = JSON.parse(req.content) as { kind?: unknown; content?: unknown };
      const content = typeof event.content === 'string' ? event.content : '';
      return `kind ${String(event.kind ?? '?')}${content ? ` - ${content}` : ''}`;
    } catch {
      return req.content;
    }
  }
</script>

<svelte:head><title>Android signer request - Deepmarks</title></svelte:head>

<div class="page">
  <a class="back" href="/app/mobile-signer">mobile signer</a>

  {#if request}
    <section class="approval">
      <div class="request-app">
        <span class="app-icon">{requesterInitial}</span>
        <div>
          <h1>{requesterName}</h1>
          {#if requesterPackage}<p>{requesterPackage}</p>{/if}
        </div>
      </div>

      <div class="approval-tabs" aria-label="Android signer request">
        <button
          type="button"
          class:active={activeTab === 'login'}
          on:click={() => showTab('login')}
        >
          login
        </button>
        <button
          type="button"
          class:active={activeTab === 'permissions'}
          on:click={() => showTab('permissions')}
        >
          permissions
        </button>
      </div>

      {#if activeTab === 'login'}
        <div class="account-card" class:mismatch={accountMismatch}>
          {#if account}
            <Avatar pubkey={account.pubkey} size={44} label={accountNpub} />
            <div>
              <strong>Deepmarks signer</strong>
              <span>{accountNpub}</span>
              {#if requestedNpub && requestedNpub !== accountNpub}
                <em>requested {requestedNpub}</em>
              {/if}
            </div>
          {:else}
            <span class="empty-avatar"></span>
            <div>
              <strong>No signer key</strong>
              <span>Add a mobile signer key before approving Android requests.</span>
            </div>
          {/if}
        </div>

        <div class="request-summary">
          <span>requested action</span>
          <strong>{requestLabel}</strong>
          {#if request.pubkey}<code>peer {shortKey(request.pubkey)}</code>{/if}
          <code>{previewContent(request)}</code>
        </div>
      {:else}
        <div class="trust-list">
          {#each trustOptions as option}
            <button
              type="button"
              class:selected={selectedTrustLevel === option.level}
              on:click={() => selectTrustLevel(option.level)}
            >
              <svelte:component this={option.icon} class="trust-icon" size={28} strokeWidth={1.8} />
              <span>
                <strong>{option.title}</strong>
                <em>{option.description}</em>
              </span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="actions">
        <button class="primary" type="button" on:click={() => void approve()} disabled={approveDisabled}>
          {approveLabel}
        </button>
        <button class="ghost" type="button" on:click={reject} disabled={working}>reject</button>
      </div>
    </section>
  {:else if !error}
    <p class="muted">loading request...</p>
  {/if}

  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .page {
    max-width: 520px;
    margin: 0 auto;
    padding: calc(env(safe-area-inset-top, 0px) + 24px) 18px calc(88px + env(safe-area-inset-bottom, 0px));
    color: var(--ink-deep);
  }
  .back {
    color: var(--ink);
    font-size: 13px;
    text-decoration: none;
  }
  .back:hover {
    color: var(--coral);
  }
  .approval {
    margin-top: 20px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
    box-shadow: 0 12px 36px var(--shadow);
  }
  .request-app {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    padding: 22px 18px 18px;
    text-align: center;
  }
  .app-icon {
    width: 58px;
    height: 58px;
    border-radius: 50%;
    border: 1px solid var(--rule);
    background: var(--paper-warm);
    color: var(--coral);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: 700 26px 'Space Grotesk', Inter, sans-serif;
  }
  h1 {
    font-family: 'Space Grotesk', Inter, sans-serif;
    font-size: 28px;
    line-height: 1.05;
    margin: 0;
    letter-spacing: 0;
    text-align: left;
  }
  .request-app p {
    margin: 4px 0 0;
    color: var(--ink);
    font-size: 13px;
    text-align: left;
    word-break: break-word;
  }
  .approval-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .approval-tabs button {
    min-width: 0;
    border: 0;
    border-radius: 0;
    background: var(--paper);
    color: var(--ink);
    padding: 12px 10px;
    font: 700 12px 'Space Grotesk', Inter, sans-serif;
    text-transform: uppercase;
    cursor: pointer;
  }
  .approval-tabs button.active {
    color: var(--ink-deep);
    box-shadow: inset 0 -3px 0 var(--coral);
  }
  .account-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    margin: 18px;
    border: 1px solid var(--coral);
    border-radius: 8px;
    background: var(--paper);
    padding: 12px;
  }
  .account-card.mismatch {
    border-color: var(--coral-deep);
    background: var(--coral-soft);
  }
  .empty-avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--paper-warmer);
  }
  .account-card strong,
  .account-card span,
  .account-card em {
    display: block;
  }
  .account-card span,
  .account-card em {
    color: var(--ink);
    font-size: 12px;
    line-height: 1.35;
    word-break: break-all;
  }
  .account-card em {
    margin-top: 4px;
    color: var(--coral-deep);
    font-style: normal;
  }
  .request-summary {
    display: grid;
    gap: 6px;
    margin: 0 18px 18px;
    padding-top: 2px;
  }
  .request-summary span {
    color: var(--ink);
    font-size: 12px;
  }
  .request-summary strong {
    font-size: 16px;
  }
  code {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    word-break: break-all;
    color: var(--ink-deep);
    background: var(--paper-warm);
    border-radius: 6px;
    padding: 7px 8px;
  }
  .trust-list {
    display: grid;
    gap: 10px;
    padding: 18px;
  }
  .trust-list button {
    width: 100%;
    min-width: 0;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-deep);
    padding: 14px 12px;
    text-align: left;
    cursor: pointer;
  }
  .trust-list button.selected {
    border-color: var(--coral);
    box-shadow: 0 0 0 2px var(--coral-soft);
  }
  :global(.trust-icon) {
    color: var(--coral);
  }
  .trust-list strong,
  .trust-list em {
    display: block;
  }
  .trust-list em {
    margin-top: 2px;
    color: var(--ink);
    font-size: 12px;
    font-style: normal;
    line-height: 1.35;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 18px 18px;
  }
  .primary,
  .ghost {
    border-radius: 999px;
    font: 600 13px 'Space Grotesk', Inter, sans-serif;
    cursor: pointer;
    white-space: nowrap;
  }
  .primary {
    border: 0;
    background: var(--coral);
    color: var(--on-coral);
    padding: 10px 16px;
  }
  .ghost {
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-deep);
    padding: 9px 15px;
  }
  .primary:disabled,
  .ghost:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .muted {
    color: var(--ink);
    font-size: 14px;
  }
  .error {
    margin-top: 14px;
    color: var(--coral-deep);
    background: var(--coral-soft);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
  }
  @media (max-width: 430px) {
    .page {
      padding-left: 12px;
      padding-right: 12px;
    }
    .request-app {
      grid-template-columns: 1fr;
      justify-items: center;
      text-align: center;
    }
    h1,
    .request-app p {
      text-align: center;
    }
    .actions {
      justify-content: stretch;
    }
    .actions button {
      flex: 1;
    }
  }
</style>
