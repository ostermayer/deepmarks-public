<script lang="ts">
  // Sign-in. Four methods, fixed positions:
  //
  //   [browser extension] — recommended; one click, NDK asks the
  //     extension. Requires a NIP-07 browser extension to be installed.
  //   [sign in with passkey] — discoverable-credential WebAuthn flow.
  //     One click; the OS picker shows every deepmarks passkey on this
  //     device, the assertion's userHandle gives us the pubkey, PRF
  //     gives us the decryption key for the stored nsec.
  //   [phone signer] — creates a Nostr Connect QR/deep link for the
  //     Deepmarks mobile app to pair as a NIP-46 signer.
  //   [remote signer] — needs a bunker URI; clicking the row
  //     reveals a panel below the list.
  //   [recovery key] — needs the nsec; clicking reveals a panel below.
  //
  // The method rows never reflow. QR / bunker / nsec input panels render
  // BELOW the full list so opening one doesn't shift the rows above —
  // this used to bite users mid-click when the panel pushed the next
  // method down under their cursor.
  //
  // Redirect target is preserved across sign-in.

  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onDestroy, onMount, tick } from 'svelte';
  import { nip19 } from 'nostr-tools';
  import { bytesToHex } from '@noble/hashes/utils';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { isNativeShell } from '$lib/native/runtime';
  import {
    createDeepmarksExtensionSigner,
    createNip46PairingSession,
    createNip07Signer,
    createNip46Signer,
    createNsecSigner,
    isDeepmarksExtensionAvailable,
    isNip07Available,
    SignerError,
  } from '$lib/nostr/signers';
  import { session } from '$lib/stores/session';
  import { hasChosenTier } from '$lib/onboarding';
  import {
    cancelPendingPasskeyCall,
    finishPasskeyNsecStorage,
    isPrfSupported,
    isWebAuthnAvailable,
    registerPasskeyAndStoreNsec,
    unlockNsecWithPasskeyDiscoverable,
  } from '$lib/nostr/passkey-auth';
  import { saveMobileSignerNsec } from '$lib/mobile/signer-account';
  import { qrScannerUnavailableMessage, startVideoQrScanner, type StopQrScanner } from '$lib/mobile/qr-scanner';
  import type { Nip46PairingSession } from '$lib/nostr/signers';

  type Method = 'extension' | 'passkey' | 'mobile' | 'bunker' | 'nsec';

  // `revealed` toggles the QR / bunker / nsec input panels (they need user
  // input, can't be one-click). Passkey + extension never set this.
  let revealed: 'mobile' | 'bunker' | 'nsec' | null = null;
  // `workingMethod` tracks which method is currently in-flight. Used to
  // disable other rows + show progress text on the working row.
  let workingMethod: Method | null = null;
  let error = '';

  let bunkerUri = '';
  let nsecInput = '';
  let pasteSaveWithPasskey = true;
  let pendingPasskeyFinishHex = '';
  let pastedNsecSignedIn = false;
  let nsecPasskeySetupActive = false;
  let nsecContinueRequested = false;
  let mobilePairing: Nip46PairingSession | null = null;
  let mobilePairingUri = '';
  let mobilePairingQr = '';
  let mobilePairingStatus = '';
  let mobilePairingRun = 0;
  let nsecScanning = false;
  let nsecVideoEl: HTMLVideoElement | null = null;
  let stopNsecQrScanner: StopQrScanner | null = null;

  $: redirectTarget = safeRedirect($page.url.searchParams.get('redirect'));
  $: extAvailable = typeof window !== 'undefined' ? isNip07Available() : false;
  $: firstPartyExtAvailable = typeof window !== 'undefined' ? isDeepmarksExtensionAvailable() : false;
  $: webAuthnAvailable = typeof window !== 'undefined' ? isWebAuthnAvailable() : false;
  $: nativeShell = isNativeShell();
  $: busy = workingMethod !== null;
  $: mobilePairingDeepLink = mobilePairingUri
    ? `deepmarks://signer?connect=${encodeURIComponent(mobilePairingUri)}`
    : '';

  onMount(() => {
    if (nativeShell) {
      revealed = 'nsec';
      pasteSaveWithPasskey = false;
      return;
    }
    if (!firstPartyExtAvailable) return;
    if (session.hint) return;
    try {
      if (sessionStorage.getItem('deepmarks-login-autologin:v1') === '1') return;
      sessionStorage.setItem('deepmarks-login-autologin:v1', '1');
    } catch {
      // Private mode — still do the one visible login-page attempt.
    }
    void loginExt(true);
  });

  onDestroy(() => {
    cancelPendingPasskeyCall();
    stopMobilePairing();
    stopNsecScan();
  });

  function safeRedirect(raw: string | null): string {
    if (!raw) return '/app/bookmarks';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/app/bookmarks';
    return raw;
  }

  function backToLanding(event: MouseEvent) {
    event.preventDefault();
    cancelPendingPasskeyCall();
    stopMobilePairing();
    workingMethod = null;
    void goto('/', { replaceState: true });
  }

  /** First-sign-in users go through /welcome to pick a tier; subsequent
   *  sign-ins jump straight to the redirect target. The flag is
   *  localStorage so it's per-device — a user signing in on a fresh
   *  browser sees the picker again. That's fine; they can pick "free"
   *  in two clicks. */
  function nextRouteAfterLogin(): string {
    return hasChosenTier() ? redirectTarget : '/welcome';
  }

  async function loginExt(firstPartyOnly = false) {
    if (busy) return;
    if (firstPartyOnly && !firstPartyExtAvailable) return;
    if (!extAvailable && !firstPartyExtAvailable) { error = 'install our extension and reload'; return; }
    error = '';
    workingMethod = 'extension';
    try {
      const s = firstPartyExtAvailable ? await createDeepmarksExtensionSigner() : await createNip07Signer();
      await session.login(s);
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = e instanceof SignerError ? e.message : (e as Error).message;
    } finally {
      workingMethod = null;
    }
  }

  async function loginWithPasskey() {
    // Click-to-cancel: a hung Bitwarden/1Password intercept can leave
    // the WebAuthn promise pending. Tapping the row again aborts it.
    if (workingMethod === 'passkey') {
      cancelPendingPasskeyCall();
      return;
    }
    if (busy) return;
    if (!webAuthnAvailable) { error = 'your browser does not support passkeys'; return; }
    error = '';
    workingMethod = 'passkey';
    try {
      const { nsecHex } = await unlockNsecWithPasskeyDiscoverable();
      const signer = await createNsecSigner(nsecHex);
      await session.login(signer, { persistNsec: true });
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = (e as Error).message || 'passkey unlock failed';
    } finally {
      workingMethod = null;
    }
  }

  function stopMobilePairing() {
    mobilePairingRun += 1;
    mobilePairing?.stop();
    mobilePairing = null;
    mobilePairingUri = '';
    mobilePairingQr = '';
    mobilePairingStatus = '';
    if (workingMethod === 'mobile') workingMethod = null;
  }

  async function copyMobilePairingUri() {
    if (!mobilePairingUri) return;
    try {
      await navigator.clipboard.writeText(mobilePairingUri);
      mobilePairingStatus = 'pairing link copied';
    } catch {
      error = 'could not copy pairing link';
    }
  }

  async function loginWithMobileSigner() {
    if (workingMethod === 'mobile') {
      stopMobilePairing();
      return;
    }
    if (busy) return;
    stopMobilePairing();
    const run = mobilePairingRun + 1;
    mobilePairingRun = run;
    revealed = 'mobile';
    error = '';
    mobilePairingStatus = 'creating pairing QR…';
    workingMethod = 'mobile';
    try {
      const pairing = await createNip46PairingSession();
      if (run !== mobilePairingRun) return;
      mobilePairing = pairing;
      mobilePairingUri = pairing.uri;
      mobilePairingQr = pairing.qrDataUrl;
      mobilePairingStatus = 'scan with the Deepmarks mobile app, or open the app link on this device';
      const signer = await pairing.waitForSigner();
      if (run !== mobilePairingRun) return;
      await session.login(signer);
      mobilePairing = null;
      mobilePairingUri = '';
      mobilePairingQr = '';
      mobilePairingStatus = '';
      void goto(nextRouteAfterLogin());
    } catch (e) {
      if (run !== mobilePairingRun) return;
      error = e instanceof SignerError ? e.message : (e as Error).message;
      mobilePairing?.stop();
      mobilePairing = null;
      mobilePairingStatus = 'start phone signer again to create a fresh QR';
    } finally {
      if (run === mobilePairingRun) workingMethod = null;
    }
  }

  function toggleBunker() {
    if (busy && workingMethod !== 'bunker') return;
    stopMobilePairing();
    stopNsecScan();
    revealed = revealed === 'bunker' ? null : 'bunker';
  }

  function toggleNsec() {
    if (busy && workingMethod !== 'nsec') return;
    stopMobilePairing();
    if (revealed === 'nsec') stopNsecScan();
    revealed = revealed === 'nsec' ? null : 'nsec';
  }

  async function loginBunker() {
    if (busy) return;
    error = '';
    workingMethod = 'bunker';
    try {
      const s = await createNip46Signer(bunkerUri.trim());
      await session.login(s);
      void goto(nextRouteAfterLogin());
    } catch (e) {
      error = e instanceof SignerError ? e.message : (e as Error).message;
    } finally {
      workingMethod = null;
    }
  }

  async function loginNsec() {
    if (busy) return;
    error = '';
    stopNsecScan();
    workingMethod = 'nsec';
    pastedNsecSignedIn = false;
    nsecPasskeySetupActive = false;
    nsecContinueRequested = false;
    try {
      const mobileAccount = nativeShell ? await saveMobileSignerNsec(nsecInput) : null;
      const signerInput = mobileAccount?.nsecHex ?? nsecInput;
      const s = await createNsecSigner(signerInput);
      const shouldSaveWithPasskey = !nativeShell && pasteSaveWithPasskey && webAuthnAvailable && (await isPrfSupported());
      const hex = shouldSaveWithPasskey ? recoveryKeyInputToHex(signerInput) : s.nsecHex;
      await session.login(s, { persistNsec: !nativeShell });
      pastedNsecSignedIn = true;
      // Optional: add Face-ID-unlock on this device next time. The raw
      // recovery key is already remembered in this browser for usability;
      // the extension remains the safer daily-use path.
      if (shouldSaveWithPasskey) {
        nsecPasskeySetupActive = true;
        const result = await registerPasskeyAndStoreNsec(s.pubkey, hex, 'deepmarks login');
        if (result.needsSecondStep) {
          pendingPasskeyFinishHex = hex;
          error = 'passkey created - click finish to open your native passkey prompt and complete setup.';
          return;
        }
      }
      continueAfterPastedNsec();
    } catch (e) {
      const message = e instanceof SignerError ? e.message : (e as Error).message;
      if (pastedNsecSignedIn) {
        pasteSaveWithPasskey = false;
        if (!nsecContinueRequested) {
          error = `signed in for this browser, but passkey setup did not finish: ${message}`;
        }
      } else {
        error = message;
      }
    } finally {
      nsecPasskeySetupActive = false;
      workingMethod = null;
    }
  }

  async function finishPastedKeyPasskey() {
    if (busy || !pendingPasskeyFinishHex) return;
    error = '';
    workingMethod = 'nsec';
    try {
      const signer = await createNsecSigner(pendingPasskeyFinishHex);
      await finishPasskeyNsecStorage(signer.pubkey, pendingPasskeyFinishHex);
      await session.login(signer, { persistNsec: true });
      continueAfterPastedNsec();
    } catch (e) {
      const message = e instanceof SignerError ? e.message : (e as Error).message;
      pastedNsecSignedIn = true;
      pasteSaveWithPasskey = false;
      error = `signed in for this browser, but passkey setup did not finish: ${message}`;
    } finally {
      workingMethod = null;
    }
  }

  function continueAfterPastedNsec() {
    nsecContinueRequested = true;
    cancelPendingPasskeyCall();
    pastedNsecSignedIn = false;
    nsecPasskeySetupActive = false;
    pendingPasskeyFinishHex = '';
    nsecInput = '';
    void goto(nextRouteAfterLogin());
  }

  function recoveryKeyInputToHex(input: string): string {
    const trimmed = input.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
    const d = nip19.decode(trimmed);
    if (d.type !== 'nsec') throw new Error('expected nsec recovery key');
    return bytesToHex(d.data);
  }

  async function startNsecScan(): Promise<void> {
    error = '';
    const unavailable = qrScannerUnavailableMessage();
    if (unavailable) {
      error = `${unavailable} Paste the recovery key instead.`;
      return;
    }
    try {
      nsecScanning = true;
      await tick();
      if (!nsecVideoEl) throw new Error('camera preview did not start');
      stopNsecQrScanner = await startVideoQrScanner(nsecVideoEl, (raw) => {
        const scannedNsec = extractNsecFromScan(raw);
        nsecScanning = false;
        stopNsecQrScanner = null;
        if (!scannedNsec) {
          error = 'QR code did not contain an nsec recovery key.';
          return;
        }
        nsecInput = scannedNsec;
        error = '';
      });
    } catch (e) {
      stopNsecScan();
      error = (e as Error).message;
    }
  }

  function stopNsecScan(): void {
    nsecScanning = false;
    stopNsecQrScanner?.();
    stopNsecQrScanner = null;
  }

  function extractNsecFromScan(raw: string): string | null {
    const trimmed = raw.trim();
    const bech32 = trimmed.match(/nsec1[023456789acdefghjklmnpqrstuvwxyz]+/i)?.[0];
    if (bech32) return bech32.toLowerCase();
    const hex = trimmed.match(/\b[0-9a-fA-F]{64}\b/)?.[0];
    return hex ? hex.toLowerCase() : null;
  }
</script>

<svelte:head><title>Sign in — Deepmarks</title></svelte:head>

<div class="page" class:native={nativeShell}>
  {#if !nativeShell}
    <a href="/" class="back" on:click={backToLanding}><Logo size={20} flip /> back</a>
  {/if}
  <h1>sign in</h1>
  <p class="lede">
    {#if nativeShell}
      paste your recovery key once. this phone stores it in the platform secure store.
    {:else}
      new here? <a href="/signup">create an identity</a>.
    {/if}
  </p>

  <div class="methods">
    <!-- Extension (one-click) -->
    {#if !nativeShell}
      <button
        type="button"
        class="method"
        class:working={workingMethod === 'extension'}
        disabled={busy && workingMethod !== 'extension'}
        on:click={() => void loginExt()}
      >
        <div class="title">browser extension <span class="rec">recommended</span></div>
        <div class="sub">
          {#if workingMethod === 'extension'}
            asking extension…
          {:else if firstPartyExtAvailable}
            Deepmarks extension detected — recovery key stays outside the site
          {:else if extAvailable}
            NIP-07 extension detected — recovery key stays outside the site
          {:else}
            install our extension and reload
          {/if}
        </div>
      </button>
      {#if !extAvailable}
        <a class="method-note" href="/extension">get the Deepmarks extension</a>
      {/if}
    {/if}

    <!-- Passkey (one-click; tap again to cancel a hung prompt) -->
    {#if !nativeShell}
      <button
        type="button"
        class="method"
        class:working={workingMethod === 'passkey'}
        disabled={busy && workingMethod !== 'passkey'}
        on:click={loginWithPasskey}
      >
        <div class="title">sign in with passkey</div>
        <div class="sub">
          {#if workingMethod === 'passkey'}
            unlocking… click again to cancel
          {:else}
            use your device passkey (Face ID / Touch ID / Windows Hello)
          {/if}
        </div>
      </button>
    {/if}

    <!-- Deepmarks mobile app (Nostr Connect QR/deep link) -->
    {#if !nativeShell}
      <button
        type="button"
        class="method"
        class:open={revealed === 'mobile'}
        class:working={workingMethod === 'mobile'}
        disabled={busy && workingMethod !== 'mobile'}
        on:click={() => void loginWithMobileSigner()}
      >
        <div class="title">phone signer</div>
        <div class="sub">
          {#if workingMethod === 'mobile'}
            waiting for the Deepmarks mobile app… click again to cancel
          {:else}
            use your iOS or Android app as the signer for this browser
          {/if}
        </div>
      </button>
    {/if}

    <!-- Bunker (input panel below) -->
    {#if !nativeShell}
      <button
        type="button"
        class="method"
        class:open={revealed === 'bunker'}
        class:working={workingMethod === 'bunker'}
        disabled={busy && workingMethod !== 'bunker'}
        on:click={toggleBunker}
      >
        <div class="title">remote signer</div>
        <div class="sub">
          {#if workingMethod === 'bunker'}
            connecting…
          {:else}
            Amber · nsec.app · self-hosted — recovery key stays with your signer
          {/if}
        </div>
      </button>
    {/if}

    <!-- Nsec (input panel below) -->
    <button
      type="button"
      class="method"
      class:open={revealed === 'nsec'}
      class:working={workingMethod === 'nsec'}
      disabled={busy && workingMethod !== 'nsec'}
      on:click={toggleNsec}
    >
      <div class="title">paste recovery key <span class="warn">advanced</span></div>
      <div class="sub">
        {#if workingMethod === 'nsec'}
          {nsecPasskeySetupActive ? 'setting up passkey…' : 'verifying…'}
        {:else if nativeShell}
          stored in Keychain on iOS and Android Keystore on Android
        {:else}
          remembered in this browser; extension is safer for daily use
        {/if}
      </div>
    </button>
  </div>

  <!-- Input panels live OUTSIDE the methods list so opening one
       doesn't push the four rows around. -->
  {#if revealed === 'mobile'}
    <div class="panel mobile-panel">
      {#if mobilePairingQr}
        <img class="qr" src={mobilePairingQr} alt="Nostr Connect QR code" />
      {:else}
        <div class="qr-placeholder">creating QR…</div>
      {/if}
      <p class="info compact">
        {mobilePairingStatus || 'scan this from Deepmarks mobile signer to pair this browser.'}
      </p>
      <div class="panel-actions">
        {#if mobilePairingDeepLink}
          <a class="primary link-button" href={mobilePairingDeepLink}>open mobile app</a>
        {/if}
        <button class="ghost" type="button" on:click={copyMobilePairingUri} disabled={!mobilePairingUri}>
          copy pairing link
        </button>
        <button class="ghost" type="button" on:click={stopMobilePairing}>
          cancel
        </button>
      </div>
      <p class="info compact">
        in the mobile app, open settings → mobile signer → scan QR. the phone keeps the recovery key;
        this browser only stores the NIP-46 pairing token.
      </p>
    </div>
  {/if}
  {#if revealed === 'bunker'}
    <div class="panel">
      <input
        type="text"
        placeholder="bunker://npub1…?relay=wss://…&secret=…"
        bind:value={bunkerUri}
      />
      <button class="primary" on:click={loginBunker} disabled={busy || !bunkerUri.trim()}>
        {workingMethod === 'bunker' ? 'connecting…' : 'connect bunker'}
      </button>
    </div>
  {/if}
  {#if revealed === 'nsec'}
    <div class="panel">
      <input
        type="password"
        placeholder="nsec1… or 64-char hex"
        bind:value={nsecInput}
        autocomplete="off"
        spellcheck="false"
      />
      {#if nativeShell}
        <div class="panel-actions">
          <button class="ghost" type="button" on:click={startNsecScan} disabled={nsecScanning}>
            scan nsec QR
          </button>
          {#if nsecScanning}
            <button class="ghost" type="button" on:click={stopNsecScan}>stop camera</button>
          {/if}
        </div>
        {#if nsecScanning}
          <video bind:this={nsecVideoEl} muted playsinline class="scanner" title="nsec QR scanner"></video>
        {/if}
      {/if}
      <p class="info compact">
        {#if nativeShell}
          recovery-key sign-in stores this key in the phone's secure store so the app can stay signed in
          and serve as a Nostr signer for other clients.
        {:else}
          recovery-key sign-in remembers this browser so refresh/back keeps working. logout clears it.
          for stronger key isolation, use the Deepmarks browser extension.
        {/if}
      </p>
      {#if !nativeShell}
        {#await isPrfSupported() then prfOk}
          {#if prfOk}
            <label class="check">
              <input type="checkbox" bind:checked={pasteSaveWithPasskey} />
              also add a passkey for future sign-ins
            </label>
          {/if}
        {/await}
      {/if}
      {#if nsecPasskeySetupActive}
        <div class="panel-actions">
          <button class="primary" type="button" disabled>setting up passkey…</button>
          <button class="ghost" type="button" on:click={continueAfterPastedNsec}>
            continue without passkey
          </button>
        </div>
        <p class="info compact">
          if Bitwarden or Orion does not show a prompt, continue now. this browser will stay signed in;
          add a passkey later in Settings or use the extension for stronger key isolation.
        </p>
      {:else if pendingPasskeyFinishHex}
        <div class="panel-actions">
          <button class="primary" on:click={finishPastedKeyPasskey} disabled={busy}>
            {workingMethod === 'nsec' ? 'finishing passkey…' : 'finish passkey setup'}
          </button>
          <button class="ghost" type="button" on:click={continueAfterPastedNsec}>
            continue without passkey
          </button>
        </div>
      {:else if pastedNsecSignedIn}
        <button class="primary" type="button" on:click={continueAfterPastedNsec}>
          continue to app
        </button>
      {:else}
        <button class="primary" on:click={loginNsec} disabled={busy || !nsecInput.trim()}>
          {workingMethod === 'nsec' ? 'verifying…' : 'sign in with recovery key'}
        </button>
      {/if}
    </div>
  {/if}

  {#if workingMethod === 'passkey'}
    <p class="info">
      if nothing happens: a password-manager extension (Bitwarden, 1Password) may be
      intercepting the prompt. unlock it, or click the row above to cancel and try a different method.
    </p>
  {/if}

  {#if error}<div class="error">{error}</div>{/if}
</div>

{#if !nativeShell}
  <Footer />
{/if}

<style>
  .page { max-width: 540px; margin: 0 auto; padding: 60px 24px 40px; position: relative; }
  .page.native { padding-top: calc(env(safe-area-inset-top, 0px) + 36px); }
  .back {
    position: absolute; top: 20px; left: 24px;
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted) !important; font-size: 12px; text-decoration: none;
  }
  .back:hover { color: var(--coral) !important; text-decoration: none; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 32px; color: var(--ink-deep); margin: 0; letter-spacing: -0.4px; }
  .lede { color: var(--ink); margin: 8px 0 24px; font-size: 14px; }
  .methods { display: flex; flex-direction: column; gap: 8px; }
  .method {
    text-align: left; background: var(--surface);
    border: 1px solid var(--rule); border-radius: 10px;
    padding: 14px 16px; cursor: pointer;
    font-family: inherit;
    transition: border-color 120ms, background 120ms;
  }
  .method:hover:not(:disabled), .method.open { border-color: var(--coral); }
  .method.working { border-color: var(--coral); background: var(--coral-soft); }
  .method:disabled { opacity: 0.5; cursor: not-allowed; }
  .method .title { font-weight: 600; color: var(--ink-deep); font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .method .sub { font-size: 12px; color: var(--ink); margin-top: 2px; line-height: 1.5; }
  .method-note {
    margin: -2px 0 4px 16px;
    color: var(--link);
    font-size: 12px;
    text-decoration: none;
    width: fit-content;
  }
  .method-note:hover {
    color: var(--coral);
  }
  .rec { background: var(--archive-soft); color: var(--archive); font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .warn { background: var(--zap-soft); color: var(--zap); font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .panel {
    margin: 12px 0 0; padding: 14px 16px;
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 10px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .mobile-panel { align-items: flex-start; }
  .qr {
    width: 180px; height: 180px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    background: #fff;
  }
  .qr-placeholder {
    width: 180px; height: 180px;
    display: grid; place-items: center;
    border: 1px dashed var(--rule);
    border-radius: 8px;
    color: var(--ink);
    font-size: 12px;
    background: var(--surface);
  }
  .panel input {
    width: 100%; box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--rule); border-radius: 6px;
    background: var(--surface); color: var(--ink-deep);
    font-family: 'Courier New', monospace; font-size: 12px;
  }
  .panel input:focus { outline: 2px solid var(--coral-soft); border-color: var(--coral); }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-deep); cursor: pointer; }
  .check input { width: auto; margin: 0; flex-shrink: 0; }
  .primary {
    background: var(--coral); color: var(--on-coral); border: 0;
    padding: 9px 14px; border-radius: 100px;
    font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px;
    align-self: flex-start;
  }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .link-button { text-decoration: none; display: inline-flex; align-items: center; }
  .ghost {
    background: transparent; border: 1px solid var(--rule); color: var(--ink-deep);
    padding: 8px 13px; border-radius: 100px;
    cursor: pointer; font-family: inherit; font-size: 13px;
  }
  .ghost:hover:not(:disabled) { border-color: var(--coral); color: var(--coral-deep); }
  .panel-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .scanner {
    width: 100%;
    max-width: 420px;
    aspect-ratio: 4 / 3;
    border: 1px solid var(--rule);
    border-radius: 8px;
    object-fit: cover;
    background: #111;
  }
  .info { color: var(--ink-deep); font-size: 12px; margin: 12px 0 0; font-style: italic; }
  .info.compact { margin: 0; }
  .error {
    margin-top: 16px; padding: 10px 14px;
    background: var(--coral-soft); color: var(--coral-deep);
    border-radius: 8px; font-size: 13px;
  }
</style>
