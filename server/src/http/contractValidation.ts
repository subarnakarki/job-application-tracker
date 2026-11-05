import { ErrorSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { isTextResponse, type TextResponse } from './contract';

export interface ContractViolation {
  method: string;
  url: string;
  status: number;
  problem: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Filled only when response validation is on (tests). */
    contractViolations: ContractViolation[];
  }
}

/** The one body for "no such route", shared by Fastify's 404 and the test-route guard. */
export const ROUTE_NOT_FOUND = { error: 'not_found', message: 'Not found' } as const;

/**
 * Test-time check that every response matches its route's declared contract.
 * A response that does not is recorded AND replaced by a 500 whose message
 * explains the violation, so any test that looks at the status fails loudly
 * with the reason, and the fuzzer's "never a 500" rule catches it too.
 *
 * Off in production: it costs a parse per response and the shapes are already
 * guaranteed by the tests.
 */
export function registerContractValidation(app: FastifyInstance): void {
  app.decorate('contractViolations', [] as ContractViolation[]);

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'HEAD') return payload;
    const status = reply.statusCode;
    const declared = request.routeOptions.config.contract?.responses;
    let schema: z.ZodType | TextResponse | null | undefined = declared?.[status];
    if (schema === undefined && status >= 400) schema = ErrorSchema;

    const problem = isTextResponse(schema)
      ? describeTextProblem(schema, String(reply.getHeader('content-type') ?? ''), payload)
      : describeProblem(schema, payload);
    if (!problem) return payload;

    app.contractViolations.push({ method: request.method, url: request.url, status, problem });
    void reply.code(500).header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify({ error: 'contract_violation', message: `${status}: ${problem}` });
  });
}

function describeTextProblem(
  spec: TextResponse,
  contentType: string,
  payload: unknown,
): string | null {
  if (!contentType.startsWith(spec.text)) return `expected ${spec.text}, got "${contentType}"`;
  return typeof payload === 'string' && payload.length > 0 ? null : 'the text body is empty';
}

function describeProblem(schema: z.ZodType | null | undefined, payload: unknown): string | null {
  const text =
    typeof payload === 'string' ? payload : payload === undefined || payload === null ? '' : null;
  if (text === null) return 'the body is not text (stream or buffer), which no route should return';
  if (schema === undefined) return 'this status is not declared for the route';
  if (schema === null)
    return text === '' ? null : 'the route declares no body for this status, but sent one';
  if (text === '') return 'the route declares a body for this status, but sent none';

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return 'the body is not JSON';
  }
  const result = schema.safeParse(body);
  return result.success
    ? null
    : result.error.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
}
