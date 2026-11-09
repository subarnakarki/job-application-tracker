import type { Db } from '../db/types';

/**
 * Token counts per Claude call, to measure what each kind of call costs (table `model_usage`).
 * Counts only: no user, no prompt or answer text.
 */
export const MODEL_CALLS = [
  'job_search',
  'draft',
  'tailor',
  'classify_email',
  'posting_keywords',
  'resume_analysis',
  'lead_message',
] as const;
export type ModelCall = (typeof MODEL_CALLS)[number];

export interface UsageEntry {
  call: ModelCall;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  webSearches: number;
}

/** Records one call. Never rejects: measuring must not break the call it measures. */
export type UsageRecorder = (entry: UsageEntry) => Promise<void>;

export const ignoreUsage: UsageRecorder = () => Promise.resolve();

/** The usage part of a Messages API response (beta or not), as the SDK returns it. */
interface ResponseUsage {
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number | null } | null;
  };
}

const count = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

export function usageEntry(call: ModelCall, response: ResponseUsage): UsageEntry {
  const { usage } = response;
  return {
    call,
    model: response.model.slice(0, 100) || 'unknown',
    inputTokens: count(usage.input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    outputTokens: count(usage.output_tokens),
    webSearches: count(usage.server_tool_use?.web_search_requests),
  };
}

/** Writes each entry to `model_usage`; a failed write is logged and dropped. */
export function dbUsageRecorder(
  db: Db | null | undefined,
  onError: (error: unknown) => void = () => {},
): UsageRecorder {
  if (!db) return ignoreUsage;
  return async (entry) => {
    try {
      await db.query(
        `insert into model_usage (call, model, input_tokens, cache_write_tokens, cache_read_tokens,
            output_tokens, web_searches)
          values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.call,
          entry.model,
          entry.inputTokens,
          entry.cacheWriteTokens,
          entry.cacheReadTokens,
          entry.outputTokens,
          entry.webSearches,
        ],
      );
    } catch (error) {
      onError(error);
    }
  };
}
