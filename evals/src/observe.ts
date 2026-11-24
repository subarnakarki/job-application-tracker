import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { claudeLimitOf } from '@jat/server/src/anthropic/limits';

/**
 * How an API error counts in an eval:
 * - `infrastructure`: the API, not the answer, failed (network, timeout, 5xx, overloaded, rate limit).
 *   The case is retried, and left out of the scores if it keeps failing.
 * - `fatal`: no call can succeed until someone acts (rejected key, spend limit, no credits). The run stops.
 * - `request`: the API refused this request (a 400 and the like). Scored as a quality failure.
 */
export type ApiErrorKind = 'infrastructure' | 'fatal' | 'request';

export function apiErrorKind(error: unknown): ApiErrorKind | null {
  if (error instanceof Anthropic.APIConnectionError) return 'infrastructure';
  if (!(error instanceof Anthropic.APIError)) return null;
  const limit = claudeLimitOf(error);
  if (limit) return limit.kind === 'spend_limit' ? 'fatal' : 'infrastructure';
  if (error instanceof Anthropic.AuthenticationError) return 'fatal';
  if (error instanceof Anthropic.PermissionDeniedError) return 'fatal';
  if (error instanceof Anthropic.InternalServerError) return 'infrastructure';
  return 'request';
}

export interface ObservedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ObservedCall {
  /** The case the call was made for, or null outside `inCase`. */
  caseId: string | null;
  requestedModel: string | null;
  /** The model that answered, from the response. */
  model: string | null;
  /** Answered by a model other than the requested one (the server-side fallback). */
  fallback: boolean;
  stopReason: string | null;
  usage: ObservedUsage | null;
  /** `other` is an error that is not an Anthropic API error at all. */
  error: { kind: ApiErrorKind | 'other'; status: number | null; message: string } | null;
  durationMs: number;
}

const OBSERVED = Symbol('observed');

/**
 * Records every `beta.messages.create` call made through a client, tagged with the case it was made for.
 * The app's clients turn API errors into `unclassified` or `null`, which would read as the model failing;
 * the observer keeps what really happened, so the eval can tell the two apart.
 */
export class Observer {
  readonly calls: ObservedCall[] = [];
  private readonly current = new AsyncLocalStorage<string>();

  /** Runs `fn` with every call it makes, however deep, tagged with `caseId`. */
  inCase<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    return this.current.run(caseId, fn);
  }

  callsFor(caseId: string): ObservedCall[] {
    return this.calls.filter((call) => call.caseId === caseId);
  }

  /** Wraps the client's `beta.messages.create` in place and returns the client. */
  attach(client: Anthropic): Anthropic {
    const messages = client.beta.messages as typeof client.beta.messages & { [OBSERVED]?: true };
    if (messages[OBSERVED]) throw new Error('This client is already observed');
    const original = messages.create.bind(messages);
    const observe = async (...args: Parameters<typeof original>): Promise<unknown> => {
      const caseId = this.current.getStore() ?? null;
      const requestedModel = typeof args[0].model === 'string' ? args[0].model : null;
      const started = performance.now();
      try {
        const response: unknown = await original(...args);
        this.calls.push({
          caseId,
          requestedModel,
          ...fromResponse(response, requestedModel),
          error: null,
          durationMs: performance.now() - started,
        });
        return response;
      } catch (error) {
        this.calls.push({
          caseId,
          requestedModel,
          model: null,
          fallback: false,
          stopReason: null,
          usage: null,
          error: describeError(error),
          durationMs: performance.now() - started,
        });
        throw error;
      }
    };
    messages.create = observe as unknown as typeof messages.create;
    messages[OBSERVED] = true;
    return client;
  }
}

function fromResponse(
  response: unknown,
  requestedModel: string | null,
): Pick<ObservedCall, 'model' | 'fallback' | 'stopReason' | 'usage'> {
  const body = isRecord(response) ? response : {};
  const model = typeof body['model'] === 'string' ? body['model'] : null;
  const usage = isRecord(body['usage']) ? body['usage'] : null;
  return {
    model,
    fallback: model !== null && requestedModel !== null && model !== requestedModel,
    stopReason: typeof body['stop_reason'] === 'string' ? body['stop_reason'] : null,
    usage: usage && {
      inputTokens: count(usage['input_tokens']),
      outputTokens: count(usage['output_tokens']),
      cacheReadTokens: count(usage['cache_read_input_tokens']),
      cacheCreationTokens: count(usage['cache_creation_input_tokens']),
    },
  };
}

function describeError(error: unknown): NonNullable<ObservedCall['error']> {
  const status =
    error instanceof Anthropic.APIError ? ((error.status as number | undefined) ?? null) : null;
  return {
    kind: apiErrorKind(error) ?? 'other',
    status,
    message: error instanceof Error ? error.message : String(error),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
