<script lang="ts">
  import Logo from './Logo.svelte';
</script>

<div class="footer">
  <Logo size={12} strokeWidth={3} />
  <span>Deepmarks</span>
  <span class="sep">·</span>
  <a href="/about">about</a>
  <span class="sep">·</span>
  <a href="/pricing">pricing</a>
  <span class="sep">·</span>
  <a href="/api">api</a>
  <span class="sep">·</span>
  <a href="/privacy">privacy</a>
  <span class="sep">·</span>
  <a href="https://github.com/nostr-protocol/nips/blob/master/B0.md" target="_blank" rel="noreferrer">nip-b0</a>
  <span class="sep">·</span>
  <a href="https://github.com/ostermayer/deepmarks-public" target="_blank" rel="noreferrer">source</a>
  <span class="sep">·</span>
  <span>v0.4.0</span>
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
  .sep {
    color: var(--rule);
  }
</style>
