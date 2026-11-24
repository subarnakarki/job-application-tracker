import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { Observer, apiErrorKind } from './observe';

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | 'network';

/** A real SDK client over a fake fetch, so errors are the SDK's own classes. */
function client(...replies: Reply[]): Anthropic {
  let next = 0;
  return new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: () => {
      const reply = replies[Math.min(next++, replies.length - 1)];
      if (reply === undefined || reply === 'network') {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json', ...reply.headers },
        }),
      );
    },
  });
}

function message(model: string, stopReason = 'end_turn') {
  return {
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: '{}' }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

function apiError(status: number, type: string, text = 'failed', headers?: Record<string, string>) {
  return { status, body: { type: 'error', error: { type, message: text } }, headers };
}

const request = (model = 'claude-opus-5-5') => ({
  model,
  max_tokens: 100,
  messages: [{ role: 'user' as const, content: 'hi' }],
});

describe('Observer', () => {
  it('records model, stop reason and usage, and returns the response unchanged', async () => {
    const observer = new Observer();
    const anthropic = observer.attach(client(message('claude-opus-5-5')));
    const response = await observer.inCase('case-1', () =>
      anthropic.beta.messages.create(request()),
    );
    expect(response.model).toBe('claude-opus-5-5');
    expect(observer.calls).toEqual([
      {
        caseId: 'case-1',
        requestedModel: 'claude-opus-5-5',
        model: 'claude-opus-5-5',
        fallback: false,
        stopReason: 'end_turn',
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, cacheCreationTokens: 0 },
        error: null,
        durationMs: expect.any(Number) as number,
      },
    ]);
  });

  it('marks an answer from another model as a fallback', async () => {
    const observer = new Observer();
    const anthropic = observer.attach(client(message('claude-sonnet-5-5', 'refusal')));
    await anthropic.beta.messages.create(request('claude-opus-5-5'));
    expect(observer.calls[0]).toMatchObject({
      caseId: null,
      model: 'claude-sonnet-5-5',
      fallback: true,
      stopReason: 'refusal',
    });
  });

  it('records an API error and rethrows it to the app', async () => {
    const observer = new Observer();
    const anthropic = observer.attach(client(apiError(529, 'overloaded_error', 'Overloaded')));
    await expect(
      observer.inCase('case-2', () => anthropic.beta.messages.create(request())),
    ).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(observer.calls[0]).toMatchObject({
      caseId: 'case-2',
      model: null,
      usage: null,
      error: {
        kind: 'infrastructure',
        status: 529,
        message: expect.stringContaining('Overloaded') as string,
      },
    });
  });

  it('keeps concurrent cases apart', async () => {
    const observer = new Observer();
    const anthropic = observer.attach(client(message('claude-opus-5-5')));
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        observer.inCase(id, async () => {
          await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 5 : 0));
          await anthropic.beta.messages.create(request());
          await anthropic.beta.messages.create(request());
        }),
      ),
    );
    expect(observer.callsFor('a')).toHaveLength(2);
    expect(observer.callsFor('b')).toHaveLength(2);
    expect(observer.calls.map((call) => call.caseId).sort()).toEqual([
      'a',
      'a',
      'b',
      'b',
      'c',
      'c',
    ]);
  });

  it('refuses to observe the same client twice', () => {
    const observer = new Observer();
    const anthropic = observer.attach(client(message('claude-opus-5-5')));
    expect(() => new Observer().attach(anthropic)).toThrow('already observed');
  });
});

describe('apiErrorKind', () => {
  async function kindOf(reply: Reply): Promise<string | null> {
    const observer = new Observer();
    const anthropic = observer.attach(client(reply));
    await anthropic.beta.messages.create(request()).catch(() => undefined);
    return observer.calls[0]?.error?.kind ?? null;
  }

  it.each([
    ['a network failure', 'network' as const],
    ['a 500', apiError(500, 'api_error')],
    ['a 529 overload', apiError(529, 'overloaded_error')],
    ['a rate limit', apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '5' })],
  ])('treats %s as infrastructure', async (_name, reply) => {
    expect(await kindOf(reply)).toBe('infrastructure');
  });

  it.each([
    ['a rejected key', apiError(401, 'authentication_error')],
    ['a forbidden key', apiError(403, 'permission_error')],
    ['a billing error', apiError(402, 'billing_error')],
    [
      'an empty credit balance',
      apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the API'),
    ],
  ])('treats %s as fatal', async (_name, reply) => {
    expect(await kindOf(reply)).toBe('fatal');
  });

  it.each([
    ['a bad request', apiError(400, 'invalid_request_error', 'max_tokens: too large')],
    ['an unknown model', apiError(404, 'not_found_error')],
  ])('treats %s as a request failure', async (_name, reply) => {
    expect(await kindOf(reply)).toBe('request');
  });

  it('is null for an error that is not from the API', () => {
    expect(apiErrorKind(new Error('boom'))).toBeNull();
  });
});
