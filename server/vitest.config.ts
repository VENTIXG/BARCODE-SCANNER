import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    // Starting the built-in PostgreSQL (WebAssembly) takes a few seconds on a busy machine.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
