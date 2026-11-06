import { ErrorSchema, type ApiErrorBody } from '@jat/shared';
import type { z } from 'zod';

/** A failed API call, with the server's error code and any field problems. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed (${status})`);
    this.name = 'ApiRequestError';
  }

  get code(): string | undefined {
    return this.body?.error;
  }

  /** Field path -> message, for showing errors next to form fields. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(
      (this.body?.issues ?? []).map((issue) => [issue.path, issue.message]),
    );
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as If-Match, for edits (optimistic concurrency). */
  version?: number;
}

/**
 * Calls the API on the same origin and parses the response with the shared
 * contract, so the client never works with a shape the server did not promise.
 * `schema: null` means the response has no body (204).
 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T> | null,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    throw new ApiRequestError(response.status, parsed.success ? parsed.data : null);
  }
  if (schema === null) return undefined as T;
  return schema.parse(await response.json());
}
