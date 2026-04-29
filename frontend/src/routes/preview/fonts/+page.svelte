<script lang="ts">
  // Pixel-font comparison page. Visit /preview/fonts and pick whichever
  // wordmark treatment feels right — then tell me the name and I'll wire
  // it into Header + landing globally.
  //
  // Shipped as a scratch route rather than embedded in the real UI so
  // nothing has to change when you decide.

  const candidates = [
    { name: 'Press Start 2P', family: "'Press Start 2P', sans-serif", note: 'Canonical 8-bit arcade. Uppercase by design.', transform: 'uppercase' as const },
    { name: 'Silkscreen (700)', family: "'Silkscreen', sans-serif", weight: 700, note: 'True bitmap font. Smooths on Firefox at non-native sizes.' },
    { name: 'Pixelify Sans (700)', family: "'Pixelify Sans', sans-serif", weight: 700, note: 'Pixel-inspired sans. Cleaner, less blocky.' },
    { name: 'VT323', family: "'VT323', monospace", note: 'Pixel terminal. Thin, tall, distinctive.' },
    { name: 'Jersey 10', family: "'Jersey 10', sans-serif", note: 'Display pixel font. Condensed.' },
    { name: 'Handjet (700)', family: "'Handjet', sans-serif", weight: 700, note: 'Variable pixel font. Modern take.' },
  ];

  const sizes = [16, 24, 32, 48] as const;
</script>

<svelte:head><title>pixel font preview — Deepmarks</title></svelte:head>

<div class="page">
  <a href="/" class="back">← back</a>
  <h1>pixel wordmark — candidates</h1>
  <p class="lede">
    Each row renders <code>deepmarks</code> at four sizes using a different
    pixel font. Pick the one that looks most 16-bit on your browser + OS and
    let me know the name; I'll swap it in globally.
  </p>

  {#each candidates as c}
    <section>
      <div class="head">
        <span class="name">{c.name}</span>
        <span class="note">{c.note}</span>
      </div>
      <div class="row">
        {#each sizes as size}
          <div class="cell">
            <span
              class="sample"
              style:font-family={c.family}
              style:font-weight={c.weight ?? 400}
              style:font-size="{size}px"
              style:text-transform={c.transform ?? 'lowercase'}
            >deepmarks</span>
            <span class="size">{size}px</span>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .page { max-width: 960px; margin: 0 auto; padding: 40px 24px 80px; }
  .back { color: var(--muted); font-size: 12px; }
  h1 { font-family: 'Press Start 2P', sans-serif; font-size: 18px; margin: 20px 0 8px; color: var(--ink-deep); }
  .lede { color: var(--ink); margin: 0 0 32px; line-height: 1.6; }
  .lede code { background: var(--paper-warm); padding: 1px 6px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; }
  section { border-top: 1px solid var(--rule); padding: 20px 0; }
  .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
  .name { font-weight: 600; color: var(--ink-deep); }
  .note { color: var(--muted); font-size: 12px; }
  .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; align-items: baseline; }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    background: var(--paper-warm);
    border-radius: 6px;
    min-height: 80px;
    justify-content: center;
  }
  .sample {
    color: var(--ink-deep);
    line-height: 1;
    display: block;
  }
  .size { color: var(--muted); font-size: 10px; font-family: 'Courier New', monospace; }
  @media (max-width: 720px) {
    .row { grid-template-columns: repeat(2, 1fr); }
  }
</style>
