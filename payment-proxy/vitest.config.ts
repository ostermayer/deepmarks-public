import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// All tests live in the repo-root /tests/payment-proxy tree (see
// /tests/README.md). @src maps back into this package's source.
export default defineConfig({
  resolve: {
    alias: {
      '@src': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    dir: fileURLToPath(new URL('../tests/payment-proxy', import.meta.url)),
    include: ['**/*.test.ts'],
    globals: false
  }
});
