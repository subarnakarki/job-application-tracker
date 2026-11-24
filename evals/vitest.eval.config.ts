import { defineConfig } from 'vitest/config';

// The evals themselves: real Anthropic calls, so never part of `npm test`. Long timeouts and no file
// parallelism keep the run inside the API's rate limits.
export default defineConfig({
  test: {
    name: 'evals:model',
    environment: 'node',
    include: ['**/*.eval.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
