import Anthropic from '@anthropic-ai/sdk';
import { SingleTurnParams } from 'deepeval/test-case';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeJudge, JUDGE_MODEL, extractJson, judgeMetrics } from './judge';

/** A real SDK client over a fake fetch that answers every call with `text`. */
function judgeAnswering(text: string, stopReason = 'end_turn') {
  const requests: Array<{ body: Record<string, unknown> }> = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: JUDGE_MODEL,
            content: [{ type: 'text', text }],
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  return { judge: new ClaudeJudge(client), requests };
}

describe('ClaudeJudge', () => {
  it('asks the judge model through the given client', async () => {
    const { judge, requests } = judgeAnswering('fine');
    expect(await judge.generate('Grade this')).toEqual({ output: 'fine', cost: null });
    expect(judge.getModelName()).toBe('claude-sonnet-5-5');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Grade this' }],
    });
  });

  it('parses a schema answer wrapped in prose', async () => {
    const { judge } = judgeAnswering('Here you go:\n```json\n{"score": 7, "reason": "ok"}\n```');
    const schema = z.object({ score: z.number(), reason: z.string() });
    expect((await judge.generate('Grade this', schema)).output).toEqual({ score: 7, reason: 'ok' });
  });

  it('rejects an answer that does not match the schema', async () => {
    const { judge } = judgeAnswering('{"score": "high"}');
    await expect(judge.generate('Grade this', z.object({ score: z.number() }))).rejects.toThrow();
  });

  it.each([
    ['refusal', 'declined'],
    ['max_tokens', 'cut off'],
  ])('fails on a %s stop', async (stopReason, message) => {
    const { judge } = judgeAnswering('{}', stopReason);
    await expect(judge.generate('Grade this')).rejects.toThrow(message);
  });
});

describe('extractJson', () => {
  it('takes the outermost object', () => {
    expect(extractJson('a {"b": {"c": 1}} d')).toEqual({ b: { c: 1 } });
  });

  it('fails without an object', () => {
    expect(() => extractJson('no json here')).toThrow('did not answer with JSON');
  });
});

describe('judgeMetrics', () => {
  it('builds GEval metrics on the Claude judge', () => {
    const { judge } = judgeAnswering('{}');
    const metric = judgeMetrics(judge).gEval({
      name: 'Tone',
      criteria: 'The tone matches the request.',
      evaluationParams: [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
    });
    expect(metric.model).toBe(judge);
    expect(metric.evaluationModel).toBe('claude-sonnet-5-5');
  });
});
