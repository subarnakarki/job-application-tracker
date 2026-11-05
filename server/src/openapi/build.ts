import { ErrorSchema } from '@jat/shared';
import { z } from 'zod';
import type { RegisteredRoute } from '../http/policy';

/**
 * Builds an OpenAPI 3.1 document from the route contracts. Nothing is written
 * by hand: paths, parameters, bodies and responses all come from the same zod
 * schemas the server validates with, so the document cannot drift from the code.
 */

type JsonSchema = Record<string, unknown>;
type Io = 'input' | 'output';

function toJsonSchema(schema: z.ZodType, io: Io): JsonSchema {
  // Refinements and transforms cannot be expressed in JSON Schema; they are enforced by the server.
  const json = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as JsonSchema;
  delete json['$schema'];
  return json;
}

function parameters(
  schema: z.ZodType | undefined,
  where: 'path' | 'query' | 'header',
): JsonSchema[] {
  if (!schema) return [];
  const json = toJsonSchema(schema, 'input');
  const properties = (json['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.has(name),
    schema: property,
  }));
}

const ERROR_REF = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ERROR_REF } },
});

function operation(route: RegisteredRoute): JsonSchema {
  const { contract } = route;
  const responses: Record<string, JsonSchema> = {};
  for (const [status, schema] of Object.entries(contract.responses)) {
    if (schema === undefined) continue;
    responses[status] =
      schema === null
        ? { description: `${status} (no body)` }
        : {
            description: `${status}`,
            content: { 'application/json': { schema: toJsonSchema(schema, 'output') } },
          };
  }
  for (const [status, description] of Object.entries(contract.errors ?? {})) {
    if (description !== undefined) responses[status] ??= errorResponse(description);
  }
  responses['400'] ??= errorResponse('The request is malformed or invalid');
  if (route.auth === 'user') responses['401'] ??= errorResponse('Not signed in');
  if (route.mutating) {
    responses['403'] ??= errorResponse('Cross-site request refused');
    responses['415'] ??= errorResponse('The body is not JSON');
  }
  responses['default'] = errorResponse('Any other error, always in the shared error shape');

  const parts = route.url.split('/').filter(Boolean);
  return {
    summary: contract.summary,
    operationId: `${route.method.toLowerCase()}${parts
      .slice(1)
      .map((part) =>
        part.startsWith(':')
          ? `By${part.slice(1, 2).toUpperCase()}${part.slice(2)}`
          : part.replace(/^./, (c) => c.toUpperCase()),
      )
      .join('')}`,
    tags: [parts[1] ?? 'api'],
    'x-auth': route.auth,
    ...(route.auth === 'user' ? { security: [{ session: [] }] } : {}),
    parameters: [
      ...parameters(contract.params, 'path'),
      ...parameters(contract.query, 'query'),
      ...parameters(contract.headers, 'header'),
    ],
    ...(contract.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: toJsonSchema(contract.body, 'input') } },
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApi(routes: readonly RegisteredRoute[]): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const sorted = [...routes].sort(
    (a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
  );
  for (const route of sorted) {
    const path = route.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = operation(route);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Job Application Tracker API',
      version: '0.1.0',
      description:
        'Generated from the route contracts in server/src/routes. Writes must be same-origin and send JSON; see docs/AUTH.md.',
    },
    paths,
    components: {
      schemas: { Error: toJsonSchema(ErrorSchema, 'output') },
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: '__Host-session' } },
    },
  };
}
