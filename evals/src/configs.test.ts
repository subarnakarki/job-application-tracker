import { describe, expect, it } from 'vitest';
import unitConfig from '../vitest.config';
import evalConfig from '../vitest.eval.config';

// `npm test` must never reach the model: the two configs may not overlap.
describe('vitest configs', () => {
  it('runs only unit tests in npm test', () => {
    expect(unitConfig.test?.include).toEqual(['**/*.test.ts']);
  });

  it('runs only eval suites in npm run eval', () => {
    expect(evalConfig.test?.include).toEqual(['**/*.eval.ts']);
  });
});
