import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_ENV, FORBIDDEN_KEYS, applyEvalEnv, checkEvalEnv, readKeystore } from './env';

const ready = (): Record<string, string | undefined> => ({
  ANTHROPIC_API_KEY: 'sk-ant-test',
  ...EVAL_ENV,
});

describe('checkEvalEnv', () => {
  it('accepts an Anthropic key with the opt-outs applied', () => {
    expect(checkEvalEnv(ready())).toEqual([]);
  });

  it('needs an Anthropic key', () => {
    expect(checkEvalEnv({ ...ready(), ANTHROPIC_API_KEY: undefined })).toEqual([
      'ANTHROPIC_API_KEY is not set',
    ]);
    expect(checkEvalEnv({ ...ready(), ANTHROPIC_API_KEY: '  ' })).toEqual([
      'ANTHROPIC_API_KEY is not set',
    ]);
  });

  it.each(FORBIDDEN_KEYS)('refuses %s in the environment', (key) => {
    expect(checkEvalEnv({ ...ready(), [key]: 'x' })).toEqual([
      `${key} is set in the environment; evals use Anthropic only`,
    ]);
  });

  it('ignores an empty forbidden key', () => {
    expect(checkEvalEnv({ ...ready(), OPENAI_API_KEY: '' })).toEqual([]);
  });

  it("refuses a forbidden key in deepeval's keystore", () => {
    expect(checkEvalEnv(ready(), { OPENAI_API_KEY: 'sk-x' })).toEqual([
      "OPENAI_API_KEY is set in deepeval's keystore; evals use Anthropic only",
    ]);
  });

  it('refuses a run with telemetry, dotenv loading or tracing left on', () => {
    expect(checkEvalEnv({ ...ready(), DEEPEVAL_TELEMETRY_OPT_OUT: undefined })).toEqual([
      'DEEPEVAL_TELEMETRY_OPT_OUT must be YES',
    ]);
    expect(checkEvalEnv({ ...ready(), CONFIDENT_TRACING_ENABLED: 'YES' })).toEqual([
      'CONFIDENT_TRACING_ENABLED must be NO',
    ]);
  });
});

describe('applyEvalEnv', () => {
  it('overrides values already in the environment', () => {
    const env: Record<string, string | undefined> = { DEEPEVAL_TELEMETRY_OPT_OUT: 'NO' };
    applyEvalEnv(env);
    expect(env).toEqual(EVAL_ENV);
  });
});

describe('readKeystore', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'jat-evals-'));

  it('reads .deepeval/.deepeval under the working directory', () => {
    const cwd = dir();
    mkdirSync(join(cwd, '.deepeval'));
    writeFileSync(join(cwd, '.deepeval', '.deepeval'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    expect(readKeystore(cwd, {})).toEqual({ OPENAI_API_KEY: 'sk-x' });
  });

  it('follows DEEPEVAL_CACHE_FOLDER', () => {
    const cwd = dir();
    mkdirSync(join(cwd, 'elsewhere'));
    writeFileSync(join(cwd, 'elsewhere', '.deepeval'), JSON.stringify({ CONFIDENT_API_KEY: 'c' }));
    expect(readKeystore(cwd, { DEEPEVAL_CACHE_FOLDER: 'elsewhere' })).toEqual({
      CONFIDENT_API_KEY: 'c',
    });
  });

  it('is empty when the file is missing or not an object', () => {
    const cwd = dir();
    expect(readKeystore(cwd, {})).toEqual({});
    mkdirSync(join(cwd, '.deepeval'));
    writeFileSync(join(cwd, '.deepeval', '.deepeval'), '[1]');
    expect(readKeystore(cwd, {})).toEqual({});
  });
});
