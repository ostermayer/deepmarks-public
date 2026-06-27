import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// All tests live in the repo-root /tests/browser-extension tree (see
// /tests/README.md). Vitest prefers this file over vite.config.ts, which
// keeps the @crxjs build plugin out of test runs. @src maps back into
// this package's source.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@src': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    dir: fileURLToPath(new URL('../tests/browser-extension', import.meta.url)),
    include: ['**/*.test.ts'],
    globals: false
  }
});
