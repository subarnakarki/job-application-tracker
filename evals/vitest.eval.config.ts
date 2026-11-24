import { defineConfig } from 'vitest/config';

// The evals themselves: real Anthropic calls, so never part of `npm test`. Long timeouts and no file
// parallelism keep the run inside the API's rate limits. global-setup.ts refuses to start without an
// Anthropic key, with another provider's key present, or with deepeval's telemetry on.
export default defineConfig({
  test: {
    name: 'evals:model',
    environment: 'node',
    include: ['**/*.eval.test.ts'],
    globalSetup: ['./global-setup.ts'],
    setupFiles: ['./setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
