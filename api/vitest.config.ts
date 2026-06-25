import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// All tests live in the repo-root /tests/api tree (see
// /tests/README.md). @src maps back into this package's source.
export default defineConfig({
  resolve: {
    alias: {
      '@src': fileURLToPath(new URL('./src', import.meta.url))
    },
    // The test tree (../tests/api) lives outside this package root, which
    // lets vite resolve a second copy of these deps for tests vs source.
    // nostr-tools shares a module-private Symbol between finalizeEvent and
    // verifyEvent, and fastify's CJS internals require single-instance
    // resolution — dedupe keeps each to one copy.
    dedupe: ['nostr-tools', '@noble/curves', '@noble/hashes', 'fastify']
  },
  test: {
    environment: 'node',
    dir: fileURLToPath(new URL('../tests/api', import.meta.url)),
    include: ['**/*.test.ts'],
    globals: false
  }
});
