import type { z } from 'zod';

export interface ValidationIssue {
  /** Dotted path into the request body, e.g. "salaryMax"; "" for the body itself. */
  path: string;
  message: string;
}

/**
 * An error the client is meant to see: a status, a stable machine-readable
 * `code`, and a message safe to show. Anything else that is thrown becomes a
 * fixed 500 (see the error handler in app.ts).
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Validates request input with a zod schema; failure becomes a 400 listing every problem. */
export function parseInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, 'validation_error', 'The request is invalid', toIssues(result.error));
  }
  return result.data;
}
