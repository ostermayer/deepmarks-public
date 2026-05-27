<script lang="ts">
  import { onMount } from 'svelte';
  import Logo from './Logo.svelte';
  import { IS_APPLE_BUILD } from '$lib/build-flags';
  import { isNativeShell } from '$lib/native/runtime';
  import { APP_VERSION } from '$lib/version';

  let nativeShell = isNativeShell();

  onMount(() => {
    nativeShell = isNativeShell();
  });
</script>

<div class="footer" class:native={nativeShell}>
  <Logo size={12} strokeWidth={3} />
  <span>Deepmarks</span>
  {#if nativeShell}
    <span class="sep">·</span>
    <span>v{APP_VERSION}</span>
  {:else}
    <span class="sep">·</span>
    <a href="/about">about</a>
    <span class="sep">·</span>
    <a href="/apps">apps</a>
    {#if !IS_APPLE_BUILD}
      <span class="sep">·</span>
      <a href="/pricing">pricing</a>
    {/if}
    <span class="sep">·</span>
    <a href="/api">api</a>
    <span class="sep">·</span>
    <a href="https://blossom.deepmarks.org">blossom</a>
    <span class="sep">·</span>
    <a href="/privacy">privacy</a>
    <span class="sep">·</span>
    <a href="/support">support</a>
    <span class="sep">·</span>
    <a href="https://github.com/nostr-protocol/nips/blob/master/B0.md" target="_blank" rel="noreferrer">nip-b0</a>
    <span class="sep">·</span>
    <a href="https://github.com/ostermayer/deepmarks-public" target="_blank" rel="noreferrer">source</a>
    <span class="sep">·</span>
    <span>v{APP_VERSION}</span>
  {/if}
</div>

<style>
  .footer {
    text-align: center;
    padding: 28px 0 40px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--rule);
    margin-top: 30px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .footer a {
    color: var(--muted);
  }
  .footer a:hover {
    color: var(--link);
  }
  .footer.native {
    border-top: 0;
    margin-top: 0;
    padding: 18px 0 calc(env(safe-area-inset-bottom, 0px) + 18px);
  }
  .sep {
    color: var(--rule);
  }
</style>
