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
export interface RouteContract {
  summary: string;
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  body?: z.ZodType;
  responses: Partial<Record<number, z.ZodType | null>>;
}
