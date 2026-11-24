import Anthropic from '@anthropic-ai/sdk';
import { claudeClassifier } from '@jat/server/src/import/classify';
import { ClaudeJudge, judgeMetrics } from './judge';
import { Observer } from './observe';

/**
 * One Anthropic client for the whole run, observed, and the app's own clients built from it exactly as
 * production builds them (same SDK defaults and retries; usage is not recorded). The key comes from
 * ANTHROPIC_API_KEY, which global-setup.ts has already checked.
 */
export const observer = new Observer();

export const anthropic = observer.attach(new Anthropic({ timeout: 120_000 }));

export const classifier = claudeClassifier(anthropic);

/** The judge for every LLM-graded metric, on the same observed client. */
export const judge = new ClaudeJudge(anthropic);

export const metrics = judgeMetrics(judge);
