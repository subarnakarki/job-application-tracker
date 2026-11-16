import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  apiFailureReason,
  claudeLimitOf,
  ClaudeLimitError,
  limitResponse,
  retryAfterSeconds,
  throwIfLimited,
} from './limits';

/** An SDK error as the SDK builds it from a response. */
function apiError(
  status: number,
  error: { type: string; message: string; details?: Record<string, unknown> },
  headers: Record<string, string> = {},
) {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error },
    undefined,
    new Headers(headers),
  );
}

describe('claudeLimitOf', () => {
  it('reads a rate limit with its retry-after', () => {
    const limit = claudeLimitOf(
      apiError(
        429,
        {
          type: 'rate_limit_error',
          message: 'Number of request tokens has exceeded your rate limit',
        },
        { 'retry-after': '12' },
      ),
    );
    expect(limit).toBeInstanceOf(ClaudeLimitError);
    expect(limit).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 12 });
  });

  it('reads a ramp limit as a rate limit', () => {
    expect(
      claudeLimitOf(
        apiError(
          429,
          {
            type: 'rate_limit_error',
            message: 'ramp',
            details: { error_code: 'ramp_limit_exceeded' },
          },
          { 'retry-after': '5' },
        ),
      ),
    ).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 5 });
  });

  it('reads the monthly spend cap (a 429 without retry-after) as a spend limit', () => {
    expect(
      claudeLimitOf(
        apiError(429, {
          type: 'rate_limit_error',
          message:
            'You have reached your API usage limits: your organization has crossed its monthly API usage threshold.',
          details: { error_code: 'enforced_spend_limit_reached' },
        }),
      ),
    ).toMatchObject({ kind: 'spend_limit', retryAfterSeconds: null });
  });

  it.each([
    'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
    'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
  ])('reads a spend limit the owner set (a 400): %s', (message) => {
    expect(claudeLimitOf(apiError(400, { type: 'invalid_request_error', message }))).toMatchObject({
      kind: 'spend_limit',
    });
  });

  it('reads prepaid credits run out (a 400 with no error code) as a spend limit', () => {
    expect(
      claudeLimitOf(
        apiError(400, {
          type: 'invalid_request_error',
          message:
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        }),
      ),
    ).toMatchObject({ kind: 'spend_limit', retryAfterSeconds: null });
  });

  it('reads a billing problem as a spend limit', () => {
    expect(
      claudeLimitOf(apiError(402, { type: 'billing_error', message: 'Payment required' })),
    ).toMatchObject({ kind: 'spend_limit' });
  });

  it('reads an overloaded API', () => {
    expect(
      claudeLimitOf(apiError(529, { type: 'overloaded_error', message: 'Overloaded' })),
    ).toMatchObject({ kind: 'overloaded', retryAfterSeconds: null });
  });

  it.each([
    ['another 400', apiError(400, { type: 'invalid_request_error', message: 'messages: bad' })],
    ['a server error', apiError(500, { type: 'api_error', message: 'Internal' })],
    ['a rejected key', apiError(401, { type: 'authentication_error', message: 'bad key' })],
    ['a dropped connection', new Anthropic.APIConnectionError({ message: 'reset' })],
    ['an error from elsewhere', new Error('boom')],
  ])('is null for %s', (_label, error) => {
    expect(claudeLimitOf(error)).toBeNull();
  });
});

describe('throwIfLimited', () => {
  it('throws the limit, and leaves any other error to the caller', () => {
    expect(() =>
      throwIfLimited(apiError(429, { type: 'rate_limit_error', message: 'slow down' })),
    ).toThrow(ClaudeLimitError);
    expect(() => throwIfLimited(new Error('boom'))).not.toThrow();
  });
});

describe('retryAfterSeconds', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');

  it('reads seconds and HTTP dates, kept between 1 s and 1 h', () => {
    expect(retryAfterSeconds('30', now)).toBe(30);
    expect(retryAfterSeconds('0.2', now)).toBe(1);
    expect(retryAfterSeconds('0', now)).toBe(1);
    expect(retryAfterSeconds('86400', now)).toBe(3600);
    expect(retryAfterSeconds('Mon, 16 Nov 2026 12:01:30 GMT', now)).toBe(90);
  });

  it('is null when there is none or it cannot be read', () => {
    expect(retryAfterSeconds(null, now)).toBeNull();
    expect(retryAfterSeconds('', now)).toBeNull();
    expect(retryAfterSeconds('soon', now)).toBeNull();
  });
});

describe('limitResponse', () => {
  it('asks to come back shortly when Claude is busy, with a retry-after', () => {
    expect(limitResponse(new ClaudeLimitError('rate_limited', 20))).toMatchObject({
      statusCode: 503,
      code: 'claude_busy',
      retryAfterSeconds: 20,
    });
    expect(limitResponse(new ClaudeLimitError('rate_limited', null)).retryAfterSeconds).toBe(60);
    expect(limitResponse(new ClaudeLimitError('overloaded', null)).retryAfterSeconds).toBe(120);
  });

  it('says the usage limit is reached, with no retry-after, for a spend limit', () => {
    const answer = limitResponse(new ClaudeLimitError('spend_limit', null));
    expect(answer).toMatchObject({
      statusCode: 503,
      code: 'claude_limit_reached',
      retryAfterSeconds: null,
    });
    expect(answer.message).toContain('usage limit');
  });
});

describe('apiFailureReason', () => {
  it("keeps Anthropic's own words, so the cause is visible", () => {
    expect(
      apiFailureReason(
        'Classifier error',
        apiError(400, { type: 'invalid_request_error', message: 'messages: text is empty' }),
      ),
    ).toBe('Classifier error 400: messages: text is empty');
  });

  it('says network for a dropped connection, and stays within the limit', () => {
    expect(
      apiFailureReason('Classifier error', new Anthropic.APIConnectionError({ message: 'reset' })),
    ).toBe('Classifier error network');
    expect(
      apiFailureReason(
        'Classifier error',
        apiError(400, { type: 'invalid_request_error', message: 'é'.repeat(500) }),
      ),
    ).toHaveLength(200);
  });
});
