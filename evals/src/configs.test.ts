import { configDefaults } from 'vitest/config';
import { describe, expect, it } from 'vitest';
import unitConfig, { EVAL_SUITE_GLOB } from '../vitest.config';
import evalConfig from '../vitest.eval.config';

// `npm test` must never reach the model: the two configs may not overlap. Every vitest file is named
// `*.test.ts`, so the eval suites (`*.eval.test.ts`) match the unit include and must be excluded from it.
describe('vitest configs', () => {
  it('runs only unit tests in npm test', () => {
    expect(unitConfig.test?.include).toEqual(['**/*.test.ts']);
    expect(unitConfig.test?.exclude).toEqual([...configDefaults.exclude, EVAL_SUITE_GLOB]);
  });

  it('runs only eval suites in npm run eval', () => {
    expect(EVAL_SUITE_GLOB).toBe('**/*.eval.test.ts');
    expect(evalConfig.test?.include).toEqual([EVAL_SUITE_GLOB]);
  });
});
