<script lang="ts">
  // Two-path signup:
  //
  //   "Create a new identity" (default, most visitors):
  //     generate nsec in-browser → register a passkey → encrypt nsec with a
  //     passkey-derived key → upload ciphertext → show the nsec once so the
  //     user can back it up → attach signer to NDK → /app/bookmarks.
  //
  //   "I already have one":
  //     three sub-paths — browser extension (NIP-07), remote bunker (NIP-46),
  //     or paste nsec. For paste, we offer passkey storage on this device
  //     so the nsec doesn't have to be re-pasted on every reload.
  //
  // Email signup is gone; session tokens still exist for API-key mgmt but
  // aren't exposed as an onboarding route any more.

  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
  import { bytesToHex } from '@noble/hashes/utils';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { session } from '$lib/stores/session';
  import { createNsecSigner } from '$lib/nostr/signers';
  import { buildNsecBackupText } from '$lib/nostr/nsec-backup';
  import { saveMobileSignerNsec } from '$lib/mobile/signer-account';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { markTierChosen } from '$lib/onboarding';
  import {
    cancelPendingPasskeyCall,
    finishPasskeyNsecStorage,
    isPrfSupported,
    isWebAuthnAvailable,
    registerPasskeyAndStoreNsec,
  } from '$lib/nostr/passkey-auth';
  import { isNativeShell, nativePlatform } from '$lib/native/runtime';

  type Step = 'branch' | 'new-generated' | 'new-passkey';

  let step: Step = 'branch';
  let error = '';
  let working = false;
  let nativeShell = isNativeShell();

  onMount(() => {
    nativeShell = isNativeShell();
  });

  /** Funnel hint from the pricing page. We hand it to /login as a
   *  redirect target for the "yes, I have a key" branch so users who
   *  came from pricing → "upgrade" still land on /app/upgrade after
   *  signing in. The tier picker itself lives at /welcome — having it
   *  there as its own route means browser back from /app/upgrade
   *  returns to the picker instead of resetting the signup wizard. */
  $: tierHint = !IS_APPLE_BUILD && $page.url.searchParams.get('tier') === 'lifetime' ? 'lifetime' : 'free';

  // ── new-key branch ──
  let newNsec = '';   // nsec1… (user-visible form)
  let newNsecHex = ''; // hex — what we pass to passkey encryption
  let newNpub = '';
  let backupConfirmed = false;
  let copied = false;
  let passkeyNeedsFinish = false;

  async function pickNew() {
    error = '';
    const sk = generateSecretKey();
    newNsecHex = bytesToHex(sk);
    newNsec = nip19.nsecEncode(sk);
    newNpub = nip19.npubEncode(getPublicKey(sk));
    step = 'new-generated';
  }

  async function pickExisting() {
    // 'Yes' path is just 'sign in' — /login has passkey + extension +
    // bunker + paste nsec. Existing users skip the choose-tier step,
    // but if they came via the pricing → "upgrade" link we still route
    // them to the upgrade page after sign-in so the lifetime intent
    // isn't lost.
    const redirect = tierHint === 'lifetime' ? '/app/upgrade' : '/app/bookmarks';
    await goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  }

  function routeAfterSignup(): string {
    if (IS_APPLE_BUILD || nativePlatform() === 'ios') {
      markTierChosen();
      return '/app/bookmarks';
    }
    return '/welcome';
  }

  async function continueFromGenerated() {
    if (!backupConfirmed) return;
    if (nativeShell) {
      try {
        working = true;
        const mobileAccount = await saveMobileSignerNsec(newNsec);
        const signer = await createNsecSigner(mobileAccount.nsecHex);
        await session.login(signer, { persistNsec: false });
        void goto(routeAfterSignup());
      } catch (e) {
        error = (e as Error).message;
      } finally {
        working = false;
      }
      return;
    }
    if (!isWebAuthnAvailable() || !(await isPrfSupported())) {
      // Device can't register a PRF-capable passkey — sign them in with
      // the nsec signer directly. They'll need to keep their nsec around
      // for cross-tab sign-ins.
      try {
        working = true;
        const signer = await createNsecSigner(newNsec);
        await session.login(signer, { persistNsec: true });
        void goto(routeAfterSignup());
      } catch (e) {
        error = (e as Error).message;
      } finally {
        working = false;
      }
      return;
    }
    step = 'new-passkey';
  }

  async function registerAndSignIn() {
    error = '';
    working = true;
    let signer: Awaited<ReturnType<typeof createNsecSigner>> | null = null;
    try {
      if (passkeyNeedsFinish) {
        await finishPasskeyNsecStorage(getPublicKey(hexToUint8(newNsecHex)), newNsecHex);
        signer = await createNsecSigner(newNsec);
        await session.login(signer, { persistNsec: true });
        void goto(routeAfterSignup());
        return;
      }
      // Order matters: attach the signer to the shared NDK pool before
      // calling registerPasskeyAndStoreNsec. The /account/passkey/register
      // POST is NIP-98 gated via buildNip98AuthHeader, which signs through
      // ndk.signer. Keep this attachment ephemeral until the ciphertext is
      // uploaded so a failed Firefox/PRF enrollment does not leave a stale
      // persisted hint that redirects the user into /app/bookmarks with no signer.
      signer = await createNsecSigner(newNsec);
      await session.attachEphemeral(signer);
      const result = await registerPasskeyAndStoreNsec(
        getPublicKey(hexToUint8(newNsecHex)),
        newNsecHex,
        'deepmarks signup',
      );
      if (result.needsSecondStep) {
        passkeyNeedsFinish = true;
        error = 'passkey created - click finish to open your native passkey prompt and complete setup.';
        return;
      }
      await session.login(signer, { persistNsec: true });
      void goto(routeAfterSignup());
    } catch (e) {
      if (signer) await session.clearEphemeral(signer);
      error = (e as Error).message || 'passkey registration failed';
    } finally {
      working = false;
    }
  }

  function hexToUint8(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  async function copyNsec() {
    try {
      await navigator.clipboard.writeText(newNsec);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch { /* user will select manually */ }
  }

  /** Let the user download the nsec as a plain .txt. Convenient for
   *  dropping into a password manager, a 1Password secure note, an
   *  encrypted USB drive, paper print-out, etc. File is generated
   *  client-side — never leaves the browser. */
  function downloadNsec() {
    const content = buildNsecBackupText({ npub: newNpub, nsec: newNsec });
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepmarks-nsec-${newNpub.slice(0, 12)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

</script>

<svelte:head><title>Sign up — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>

  {#if step === 'branch'}
    <h1>do you already have a nostr identity?</h1>
    <div class="yesno">
      <button class="primary pill" type="button" on:click={pickExisting} disabled={working}>yes</button>
      <button class="primary pill" type="button" on:click={pickNew} disabled={working}>no</button>
    </div>
    <p class="footnote-small">
      <strong>yes</strong> — sign in with a passkey, extension, remote signer, or recovery key.<br/>
      <strong>no</strong> — we'll create an identity and help you back up the recovery key.
    </p>
    <p class="footnote">just looking? <a href="/app/explore">browse the network →</a></p>

  {:else if step === 'new-generated'}
    <h1>your recovery key</h1>
    <p class="lede">
      Deepmarks created a Nostr identity on this device. Your <strong>public identity</strong>
      is safe to share; your <strong>recovery key</strong> must stay private.
    </p>

    <div class="key">
      <div class="key-label">public identity</div>
      <code>{newNpub}</code>
    </div>

    <div class="key warn">
      <div class="key-label">recovery key <span class="faded">— never share, never lose</span></div>
      <code>{newNsec}</code>
      <div class="key-actions">
        <button type="button" class="ghost" on:click={copyNsec}>{copied ? 'copied ✓' : 'copy'}</button>
        <button type="button" class="ghost" on:click={downloadNsec}>download .txt</button>
      </div>
      <p class="hint">
        save this in your password manager or on paper. if you lose access to this {nativeShell ? 'device' : 'browser'}
        and do not have this key backed up, the account is gone — Nostr has no password reset.
      </p>
    </div>

    <label class="check">
      <input type="checkbox" bind:checked={backupConfirmed} />
      i've backed up my recovery key somewhere i trust.
    </label>

    {#if error}<div class="error">{error}</div>{/if}

    <button class="primary" type="button" disabled={!backupConfirmed || working} on:click={continueFromGenerated}>
      {working ? 'working…' : 'continue →'}
    </button>

  {:else if step === 'new-passkey'}
    <h1>set up a passkey</h1>
    <p class="lede">
      we'll encrypt your recovery key with a key derived from your passkey and store the ciphertext on
      our server. we never see the decryption key — only your passkey can unlock it.
    </p>

    <p class="passkey-explain">
      on this and any device synced via iCloud Keychain or Google Password Manager, you'll be
      able to sign in with your passkey (Face ID / Touch ID / Windows Hello / your device unlock).
      switching ecosystems
      (iOS ↔ Android) may need a one-time recovery-key import.
    </p>

    {#if error}<div class="error">{error}</div>{/if}

    <div class="btn-row">
      <button class="primary" type="button" disabled={working} on:click={registerAndSignIn}>
        {#if working}
          {passkeyNeedsFinish ? 'finishing passkey…' : 'waiting for passkey…'}
        {:else if passkeyNeedsFinish}
          finish passkey setup →
        {:else}
          set up passkey →
        {/if}
      </button>
      {#if working}
        <button
          class="ghost"
          type="button"
          on:click={() => {
            // Abort the hanging WebAuthn call so the UI can move on.
            // Some password-manager extensions (Bitwarden logged-out,
            // some 1Password configs) silently swallow the prompt and
            // never resolve the promise.
            cancelPendingPasskeyCall();
          }}
        >
          cancel
        </button>
      {:else}
        <button class="ghost" type="button" on:click={async () => {
          working = true;
          try {
            const signer = await createNsecSigner(newNsec);
            await session.login(signer, { persistNsec: true });
            void goto(routeAfterSignup());
          } catch (e) {
            error = (e as Error).message;
          } finally { working = false; }
        }}>
          skip — i'll manage my own private key
        </button>
      {/if}
    </div>
    {#if working}
      <p class="hint">
        if nothing happens within a few seconds: your password manager extension
        (Bitwarden, 1Password, etc.) may be intercepting the request. try unlocking
        it, or hit cancel and choose 'skip' to continue without a passkey.
      </p>
    {/if}

  {/if}
</div>

<Footer />

<style>
  .page { max-width: 540px; margin: 0 auto; padding: 60px 24px 40px; position: relative; }
  .back {
    position: absolute; top: 20px; left: 24px;
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted) !important; font-size: 12px; text-decoration: none;
  }
  .back:hover { color: var(--coral) !important; text-decoration: none; }
  h1 { font-family: 'Space Grotesk', Inter, sans-serif; font-size: 28px; color: var(--ink-deep); margin: 0 0 8px; letter-spacing: -0.4px; }
  .lede { color: var(--ink); margin: 0 0 20px; font-size: 14px; line-height: 1.55; }
  .footnote { margin-top: 24px; color: var(--muted); font-size: 12px; text-align: center; }
  .footnote-small { margin: 16px 0 0; color: var(--ink); font-size: 12px; line-height: 1.7; }
  .yesno { display: flex; gap: 12px; justify-content: center; margin: 28px 0 8px; }
  .pill { min-width: 120px; padding: 14px 24px !important; font-size: 15px !important; letter-spacing: 0.5px; text-transform: uppercase; font-weight: 600 !important; }
  .key {
    background: var(--paper-warm);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .key.warn { background: var(--zap-soft); border-color: var(--zap); }
  .key-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--ink-deep); font-weight: 600; margin-bottom: 6px; }
  .key code { display: block; font-family: 'Courier New', monospace; font-size: 11px; color: var(--ink-deep); word-break: break-all; background: var(--surface); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--rule); }
  .key-actions { margin-top: 8px; }
  .hint { margin: 10px 0 0; color: var(--ink); font-size: 12px; line-height: 1.5; }
  .passkey-explain { padding: 10px 12px; background: var(--paper-warm); border-left: 3px solid var(--coral); border-radius: 4px; color: var(--ink-deep); font-size: 12.5px; line-height: 1.55; margin: 0 0 16px; }
  .faded { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--ink-deep); margin: 12px 0 16px; cursor: pointer; }
  .check input { margin-top: 3px; flex-shrink: 0; }
  .primary { background: var(--coral); color: var(--on-coral); border: 0; padding: 10px 18px; border-radius: 100px; font-weight: 500; cursor: pointer; font-family: inherit; font-size: 13px; }
  .primary:hover:not(:disabled) { background: var(--coral-deep); }
  .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .ghost { background: transparent; border: 1px solid var(--rule); color: var(--ink-deep); padding: 9px 16px; border-radius: 100px; cursor: pointer; font-family: inherit; font-size: 13px; }
  .ghost:hover:not(:disabled) { border-color: var(--coral); color: var(--coral-deep); }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .error { padding: 8px 12px; background: var(--coral-soft); color: var(--coral-deep); border-radius: 8px; font-size: 12px; margin: 10px 0; }
</style>
