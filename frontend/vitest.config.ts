import { defineConfig } from 'vitest/config';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';

// All tests live in the repo-root /tests/frontend tree (see /tests/README.md).
// $lib resolves via the sveltekit plugin; $src covers the rare import from
// outside src/lib.
export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      $src: fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    dir: fileURLToPath(new URL('../tests/frontend', import.meta.url)),
    include: ['**/*.test.ts'],
    globals: false
  }
});
