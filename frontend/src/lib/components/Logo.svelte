<script lang="ts">
  // Coral signal-pennant glyph — drawn as discrete 2-unit pixel blocks so
  // it reads as a 16-bit sprite at any size. The silhouette matches the
  // original smooth version pixel-for-pixel at 16×16 resolution.
  //
  // `shape-rendering="crispEdges"` disables the browser's antialiasing so
  // the stepped triangle stays clearly blocky.
  export let size: number = 26;
  /** Kept for API compatibility; ignored now that the mast is a rect. */
  export let strokeWidth: number = 2.5;
  void strokeWidth;
  /** Flip the pennant to point left — used on "back" affordances. */
  export let flip: boolean = false;
</script>

<svg
  class="glyph"
  class:flip
  width={size}
  height={size}
  viewBox="0 0 32 32"
  xmlns="http://www.w3.org/2000/svg"
  shape-rendering="crispEdges"
  aria-hidden="true"
>
  <!-- mast: 2-unit column, longer stem below the pennant -->
  <rect x="6" y="2" width="2" height="30" fill="#ff6b5a" />
  <!-- pennant: stepped triangle pointing right, sits in the upper third -->
  <rect x="8" y="4"  width="4"  height="2" fill="#ff6b5a" />
  <rect x="8" y="6"  width="8"  height="2" fill="#ff6b5a" />
  <rect x="8" y="8"  width="12" height="2" fill="#ff6b5a" />
  <rect x="8" y="10" width="14" height="2" fill="#ff6b5a" />
  <rect x="8" y="12" width="12" height="2" fill="#ff6b5a" />
  <rect x="8" y="14" width="8"  height="2" fill="#ff6b5a" />
  <rect x="8" y="16" width="4"  height="2" fill="#ff6b5a" />
</svg>

<style>
  .glyph {
    image-rendering: pixelated;
  }
  .glyph.flip {
    transform: scaleX(-1);
  }
</style>
