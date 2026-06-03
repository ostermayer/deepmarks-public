import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

const browser = (process.env.BROWSER as 'chrome' | 'firefox') ?? 'chrome';
const appleBuild = process.env.VITE_APPLE_BUILD === '1';

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
      output: appleBuild
        ? {
            // Safari can keep an extension popup document alive while a
            // local debug rebuild replaces Resources/. Stable filenames
            // avoid a blank popover caused by cached HTML pointing at a
            // deleted hashed JS chunk.
            entryFileNames: 'assets/[name].js',
            chunkFileNames: 'assets/[name].js',
            assetFileNames: 'assets/[name][extname]',
          }
        : undefined,
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
