<script lang="ts">
  // Two-path signup:
  //
  //   "I don't have a key" (default, most visitors):
  //     generate nsec in-browser → register a passkey → encrypt nsec with a
  //     passkey-derived key → upload ciphertext → show the nsec once so the
  //     user can back it up → attach signer to NDK → /app.
  //
  //   "I have a key":
  //     three sub-paths — browser extension (NIP-07), remote bunker (NIP-46),
  //     or paste nsec. For paste, we offer passkey storage on this device
  //     so the nsec doesn't have to be re-pasted on every reload.
  //
  // Email signup is gone; session tokens still exist for API-key mgmt but
  // aren't exposed as an onboarding route any more.

  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
  import { bytesToHex } from '@noble/hashes/utils';
  import Logo from '$lib/components/Logo.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import { session } from '$lib/stores/session';
  import { createNsecSigner } from '$lib/nostr/signers';
  import { config } from '$lib/config';
  import { markTierChosen } from '$lib/onboarding';
  import {
    cancelPendingPasskeyCall,
    isPrfSupported,
    isWebAuthnAvailable,
    registerPasskeyAndStoreNsec,
  } from '$lib/nostr/passkey-auth';

  type Step = 'branch' | 'new-generated' | 'new-passkey' | 'choose-tier';

  let step: Step = 'branch';
  let error = '';
  let working = false;

  /** Funnel hint from the pricing page. Doesn't gate anything any more —
   *  the user picks their tier on the choose-tier step *after* they've
   *  successfully signed up. We still read it so the lifetime button can
   *  be highlighted as the suggested default for users who came from the
   *  pricing → "upgrade" link. */
  $: tierHint = $page.url.searchParams.get('tier') === 'lifetime' ? 'lifetime' : 'free';

  // ── new-key branch ──
  let newNsec = '';   // nsec1… (user-visible form)
  let newNsecHex = ''; // hex — what we pass to passkey encryption
  let newNpub = '';
  let backupConfirmed = false;
  let copied = false;

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
    const redirect = tierHint === 'lifetime' ? '/app/upgrade' : '/app';
    await goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  }

  async function continueFromGenerated() {
    if (!backupConfirmed) return;
    if (!isWebAuthnAvailable() || !(await isPrfSupported())) {
      // Device can't register a PRF-capable passkey — sign them in with
      // the nsec signer directly. They'll need to keep their nsec around
      // for cross-tab sign-ins.
      try {
        working = true;
        const signer = await createNsecSigner(newNsec);
        await session.login(signer);
        step = 'choose-tier';
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
    try {
      await registerPasskeyAndStoreNsec(
        getPublicKey(hexToUint8(newNsecHex)),
        newNsecHex,
        'deepmarks signup',
      );
      const signer = await createNsecSigner(newNsec);
      await session.login(signer);
      step = 'choose-tier';
    } catch (e) {
      error = (e as Error).message || 'passkey registration failed';
    } finally {
      working = false;
    }
  }

  function pickTier(tier: 'free' | 'lifetime') {
    markTierChosen();
    void goto(tier === 'lifetime' ? '/app/upgrade' : '/app');
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
    const content = buildBackupText(newNpub, newNsec);
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

  function buildBackupText(npub: string, nsec: string): string {
    return [
      `# Deepmarks — Nostr identity backup`,
      `# Generated ${new Date().toISOString()}`,
      ``,
      `# Your npub is your PUBLIC identity. Safe to share.`,
      `npub: ${npub}`,
      ``,
      `# Your nsec is your PRIVATE KEY. Anyone holding it controls the account forever.`,
      `# Treat it like a seed phrase. There is no recovery if you lose it.`,
      `nsec: ${nsec}`,
      ``,
      `# You can import this nsec into any Nostr client: Damus, Primal, Amethyst,`,
      `# Alby (browser extension), nsec.app, Amber, etc. The same identity works`,
      `# across every Nostr app.`,
    ].join('\n');
  }

</script>

<svelte:head><title>Sign up — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back"><Logo size={20} flip /> back</a>

  {#if step === 'branch'}
    <h1>do you have a private key?</h1>
    <div class="yesno">
      <button class="primary pill" type="button" on:click={pickExisting} disabled={working}>yes</button>
      <button class="primary pill" type="button" on:click={pickNew} disabled={working}>no</button>
    </div>
    <p class="footnote-small">
      <strong>yes</strong> — sign in with your extension, bunker, or by pasting your nsec.<br/>
      <strong>no</strong> — we'll generate one and set up a passkey on this device.
    </p>
    <p class="footnote">just looking? <a href="/app/network">browse the network →</a></p>

  {:else if step === 'new-generated'}
    <h1>your new nostr key</h1>
    <p class="lede">
      two strings make up a nostr identity: the <strong>npub</strong> is public (share freely),
      the <strong>nsec</strong> is the private key that IS your account.
    </p>

    <div class="key">
      <div class="key-label">npub</div>
      <code>{newNpub}</code>
    </div>

    <div class="key warn">
      <div class="key-label">nsec <span class="faded">— never share, never lose</span></div>
      <code>{newNsec}</code>
      <div class="key-actions">
        <button type="button" class="ghost" on:click={copyNsec}>{copied ? 'copied ✓' : 'copy'}</button>
        <button type="button" class="ghost" on:click={downloadNsec}>download .txt</button>
      </div>
      <p class="hint">
        save this in your password manager or on paper. if you ever lose access to this browser
        AND don't have this nsec backed up, the account is gone — nostr has no password reset.
      </p>
    </div>

    <label class="check">
      <input type="checkbox" bind:checked={backupConfirmed} />
      i've backed up my nsec somewhere i trust.
    </label>

    {#if error}<div class="error">{error}</div>{/if}

    <button class="primary" type="button" disabled={!backupConfirmed || working} on:click={continueFromGenerated}>
      {working ? 'working…' : 'continue →'}
    </button>

  {:else if step === 'new-passkey'}
    <h1>set up a passkey</h1>
    <p class="lede">
      we'll encrypt your nsec with a key derived from your passkey and store the ciphertext on
      our server. we never see the decryption key — only your passkey can unlock it.
    </p>

    <p class="passkey-explain">
      on this and any device synced via iCloud Keychain or Google Password Manager, you'll be
      able to sign in with your passkey (Face ID / Touch ID / Windows Hello / your device unlock).
      switching ecosystems
      (iOS ↔ Android) needs a one-time nsec re-paste.
    </p>

    {#if error}<div class="error">{error}</div>{/if}

    <div class="btn-row">
      <button class="primary" type="button" disabled={working} on:click={registerAndSignIn}>
        {working ? 'waiting for passkey…' : 'set up passkey →'}
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
            await session.login(signer);
            step = 'choose-tier';
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

  {:else if step === 'choose-tier'}
    <h1>you're in ✓ pick a plan</h1>
    <p class="lede">
      free is enough for most people. lifetime is a one-time payment that lets you archive every
      bookmark forever instead of paying per save.
    </p>
    <div class="tier-cards">
      <button
        type="button"
        class="tier-card"
        class:default={tierHint !== 'lifetime'}
        on:click={() => pickTier('free')}
      >
        <strong class="tier-card-h">free</strong>
        <p class="tier-card-amt">{config.archivePriceSats} sats per archived URL</p>
        <p class="tier-card-blurb">
          unlimited bookmarks, public + private. archive forever costs sats only when you actually
          archive a URL.
        </p>
        <span class="tier-card-cta">go to app →</span>
      </button>
      <button
        type="button"
        class="tier-card"
        class:default={tierHint === 'lifetime'}
        on:click={() => pickTier('lifetime')}
      >
        <strong class="tier-card-h">lifetime</strong>
        <p class="tier-card-amt">{config.lifetimePriceSats.toLocaleString()} sats once</p>
        <p class="tier-card-blurb">
          archive every bookmark forever, no per-URL fee. one-time payment. you can pay later from
          settings if you want to think about it.
        </p>
        <span class="tier-card-cta">pay + go →</span>
      </button>
    </div>
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
  .tier-cards { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .tier-card {
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 16px 18px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 120ms, transform 80ms;
  }
  .tier-card:hover { border-color: var(--coral); }
  .tier-card:active { transform: translateY(1px); }
  .tier-card.default { border-color: var(--coral); background: var(--coral-soft); }
  .tier-card-h { display: block; font-family: 'Space Grotesk', Inter, sans-serif; font-size: 20px; color: var(--ink-deep); }
  .tier-card-amt { margin: 4px 0 8px; color: var(--coral-deep); font-size: 13px; font-weight: 600; }
  .tier-card-blurb { margin: 0 0 10px; font-size: 12.5px; color: var(--ink); line-height: 1.55; }
  .tier-card-cta { color: var(--coral-deep); font-size: 12px; font-weight: 600; }
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
