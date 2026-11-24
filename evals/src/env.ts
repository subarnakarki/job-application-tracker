import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Set before deepeval is imported. deepeval reads `.env` files into `process.env` on import, sends usage
 * telemetry to PostHog and traces to Confident AI by default; none of that is wanted here.
 */
export const EVAL_ENV = {
  DEEPEVAL_TELEMETRY_OPT_OUT: 'YES',
  DEEPEVAL_DISABLE_DOTENV: 'YES',
  CONFIDENT_TRACING_ENABLED: 'NO',
} as const;

/**
 * Keys for every other provider deepeval can use. Its judge falls back to OpenAI when a metric is built
 * without one, so a key left lying around would quietly send data elsewhere. Evals use Anthropic only.
 */
export const FORBIDDEN_KEYS = [
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_AD_TOKEN',
  'CONFIDENT_API_KEY',
  'GOOGLE_API_KEY',
  'GROK_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'LOCAL_MODEL_API_KEY',
  'PORTKEY_API_KEY',
  'OPENROUTER_API_KEY',
  'TYPESAFE_API_KEY',
] as const;

type Env = Record<string, string | undefined>;

/** Overwrites, so a stray `DEEPEVAL_TELEMETRY_OPT_OUT=NO` in the shell cannot turn telemetry back on. */
export function applyEvalEnv(env: Env): void {
  Object.assign(env, EVAL_ENV);
}

const isSet = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

/**
 * Problems that stop an eval run, empty when it may start. `keystore` is deepeval's own key file
 * (`.deepeval/.deepeval`), which it reads alongside the environment.
 */
export function checkEvalEnv(env: Env, keystore: Record<string, unknown> = {}): string[] {
  const problems: string[] = [];
  if (!isSet(env.ANTHROPIC_API_KEY)) problems.push('ANTHROPIC_API_KEY is not set');
  for (const key of FORBIDDEN_KEYS) {
    if (isSet(env[key]))
      problems.push(`${key} is set in the environment; evals use Anthropic only`);
    if (isSet(keystore[key]))
      problems.push(`${key} is set in deepeval's keystore; evals use Anthropic only`);
  }
  for (const [key, value] of Object.entries(EVAL_ENV)) {
    if (env[key] !== value) problems.push(`${key} must be ${value}`);
  }
  return problems;
}

/** deepeval's keystore, resolved the way deepeval resolves it; empty when there is none. */
export function readKeystore(cwd: string, env: Env = process.env): Record<string, unknown> {
  const path = join(cwd, env.DEEPEVAL_CACHE_FOLDER || '.deepeval', '.deepeval');
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
