import { configDefaults, defineConfig } from 'vitest/config';
import { EVAL_ENV } from './src/env';

// Unit tests for the eval tooling. Part of the root `npm test`, so nothing here may call Anthropic: model
// calls live only in `*.eval.test.ts`, which this config excludes and vitest.eval.config.ts runs through
// `npm run eval`. The eval environment applies here too, because importing deepeval loads `.env` files
// unless told not to.
export const EVAL_SUITE_GLOB = '**/*.eval.test.ts';

export default defineConfig({
  test: {
    name: 'evals',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: [...configDefaults.exclude, EVAL_SUITE_GLOB],
    env: { ...EVAL_ENV },
  },
});
