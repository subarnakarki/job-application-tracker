import type { z } from 'zod';

/**
 * What a route accepts and returns, declared next to `auth` in the route config.
 * The same declarations drive three things:
 * - in tests, every response is validated against them (see contractValidation.ts);
 * - the OpenAPI document is generated from them;
 * - the API fuzzer generates requests from them.
 *
 * `responses` lists the statuses a route returns on purpose, with the schema of
 * each body (`null` = no body, e.g. 204). Any other 4xx/5xx must match the shared
 * ErrorSchema; any other 2xx/3xx is a contract violation.
 */
/** A non-JSON body (for example a CSV download), identified by its media type. */
export interface TextResponse {
  text: string;
}

export function isTextResponse(value: unknown): value is TextResponse {
  return typeof value === 'object' && value !== null && !('_zod' in value) && 'text' in value;
}

export interface RouteContract {
  summary: string;
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  body?: z.ZodType;
  responses: Partial<Record<number, z.ZodType | null | TextResponse>>;
  /**
   * Error statuses the route returns on purpose, with what they mean. Their bodies use the shared
   * ErrorSchema. 400 for a malformed request, 401 on signed-in routes and 403/415 on writes are
   * implied and need not be listed.
   */
  errors?: Partial<Record<number, string>>;
}
