<script lang="ts">
  export let title: string;
  export let note = '';
</script>

<section>
  <h2>{title}{#if note} <span>{note}</span>{/if}</h2>
  <slot />
</section>

<style>
  section {
    margin-top: 32px;
  }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    color: var(--ink-deep);
    letter-spacing: 0;
    margin: 0 0 12px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  h2 span {
    color: var(--muted);
    text-transform: none;
  }
  :global(.settings-section-copy) {
    color: var(--ink-deep);
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 12px;
  }
  :global(.settings-section-copy strong) {
    color: var(--ink-deep);
    font-weight: 600;
  }
  :global(.settings-section-copy code) {
    font-family: 'Courier New', monospace;
    font-size: 12px;
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
  }
</style>
