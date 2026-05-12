import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

const browser = (process.env.BROWSER as 'chrome' | 'firefox') ?? 'chrome';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest, browser }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // The popup HTML is the React entry point; @crxjs picks it up
      // from the manifest's action.default_popup. No extra inputs needed.
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    hmr: {
      port: 5174,
    },
  },
});
