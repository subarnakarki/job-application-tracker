import type Anthropic from '@anthropic-ai/sdk';
import { DeepEvalBaseLLM, type GenerationResult } from 'deepeval/models';
import { GEval, type GEvalMetricOptions } from 'deepeval/metrics';
import type { ZodType } from 'zod';

/** Grades the app's `claude-haiku-5-5` answers: a larger model, and not the one being graded. See the plan on bias. */
export const JUDGE_MODEL = 'claude-sonnet-5-5';

const JUDGE_MAX_TOKENS = 4000;

/**
 * deepeval's judge interface over the eval's own observed client, so judge calls are counted and costed
 * like the app's. (deepeval's `AnthropicModel` builds a client of its own that the observer never sees.)
 */
export class ClaudeJudge extends DeepEvalBaseLLM {
  constructor(private readonly client: Pick<Anthropic, 'beta'>) {
    super(JUDGE_MODEL);
  }

  async generate<T = string>(prompt: string, schema?: ZodType<T>): Promise<GenerationResult<T>> {
    const response = await this.client.beta.messages.create({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The judge declined to answer');
    if (response.stop_reason === 'max_tokens') throw new Error("The judge's answer was cut off");
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    // T defaults to string: without a schema deepeval asks for, and gets, the raw text.
    const output = schema ? schema.parse(extractJson(text)) : (text as unknown as T);
    return { output, cost: null };
  }

  getModelName(): string {
    return JUDGE_MODEL;
  }
}

/** The outermost JSON object in a judge's answer, which may come wrapped in prose or a code fence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('The judge did not answer with JSON');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export type GEvalOptions = Omit<GEvalMetricOptions, 'model'>;

/**
 * The only way to build a judge metric (lint forbids constructing deepeval's LLM metrics elsewhere).
 * A metric built without a model would fall back to deepeval's default judge, OpenAI.
 */
export function judgeMetrics(judge: ClaudeJudge): { gEval(options: GEvalOptions): GEval } {
  return {
    gEval: (options) => new GEval({ ...options, model: judge }),
  };
}
