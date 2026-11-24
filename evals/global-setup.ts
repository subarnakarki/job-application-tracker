import { applyEvalEnv, checkEvalEnv, readKeystore } from './src/env';

// Runs once in the main process before any worker starts; workers inherit its environment. deepeval is
// imported only after the opt-outs are applied, because it loads settings and dotenv files on import.
export default async function setup(): Promise<() => Promise<void>> {
  applyEvalEnv(process.env);
  const problems = checkEvalEnv(process.env, readKeystore(process.cwd()));
  if (problems.length > 0) {
    throw new Error(`Eval run refused:\n- ${problems.join('\n- ')}`);
  }
  const { default: deepevalSetup } = await import('deepeval/vitest/global-setup');
  return deepevalSetup();
}
