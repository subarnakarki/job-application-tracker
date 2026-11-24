import { defineConfig } from 'vitest/config';

// Unit tests for the eval tooling. Part of the root `npm test`, so nothing here may call Anthropic: model
// calls live only in `*.eval.ts`, which vitest.eval.config.ts runs through `npm run eval`.
export default defineConfig({
  test: {
    name: 'evals',
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
