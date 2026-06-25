import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false
  },
  optimizeDeps: {
    // NDK + nostr-tools pull in node-style imports; pre-bundle for dev speed.
    include: ['@nostr-dev-kit/ndk', 'nostr-tools', '@nostrify/nostrify']
  },
  // Disable module preloading so content blockers (uBlock, Brave Shields,
  // Safari content blockers) that pattern-match on the `<link rel="modulepreload">`
  // URLs don't take down hydration by failing one preload unhandled.
  // The tradeoff is a slightly slower first-paint on network-constrained
  // clients — worth it for the fraction of users running blockers.
  build: {
    modulePreload: false,
  },
});
