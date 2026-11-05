import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { generateSpec, SPEC_PATH } from './generate';

type Operation = {
  summary?: string;
  operationId?: string;
  parameters?: { name: string; in: string }[];
  responses: Record<string, unknown>;
  security?: unknown[];
  'x-auth'?: string;
};
type Spec = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, unknown>;
};

const operations = (spec: Spec) =>
  Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
  );

describe('OpenAPI document', () => {
  it('is up to date: the committed docs/openapi.json equals what the code generates (run `npm run openapi`)', async () => {
    const committed: unknown = JSON.parse(await readFile(SPEC_PATH, 'utf8'));

    expect(committed).toEqual(await generateSpec());
  });

  it('describes exactly the public routes, never the test-only ones', async () => {
    const spec = (await generateSpec()) as Spec;
    const app = buildApp({ env: {} });
    await app.ready();
    const expected = app.registeredRoutes
      .map((route) => `${route.method.toLowerCase()} ${route.url.replace(/:(\w+)/g, '{$1}')}`)
      .sort();
    await app.close();

    expect(
      operations(spec)
        .map(({ path, method }) => `${method} ${path}`)
        .sort(),
    ).toEqual(expected);
    expect(Object.keys(spec.paths).some((path) => path.startsWith('/api/test'))).toBe(false);
  });

  it('is excluded from test routes even when the environment would enable them', async () => {
    // generateSpec builds the app with an empty environment on purpose.
    const spec = JSON.stringify(await generateSpec());

    expect(spec).not.toContain('/api/test/');
    expect(spec).not.toContain('x-test-secret');
  });

  it('gives every operation a summary, a unique id, a success response and an error fallback', async () => {
    const spec = (await generateSpec()) as Spec;
    const ids = new Set<string>();

    for (const { path, method, operation } of operations(spec)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(operation.summary, where).toBeTruthy();
      expect(operation.operationId, where).toBeTruthy();
      expect(ids.has(operation.operationId ?? ''), `${where} duplicate operationId`).toBe(false);
      ids.add(operation.operationId ?? '');
      expect(
        Object.keys(operation.responses).some((status) => /^[23]\d\d$/.test(status)),
        where,
      ).toBe(true);
      expect(operation.responses['default'], where).toBeDefined();
    }
  });

  it('declares every path parameter that appears in a path', async () => {
    const spec = (await generateSpec()) as Spec;

    for (const { path, method, operation } of operations(spec)) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const declared = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'path')
        .map((p) => p.name);
      expect(declared.sort(), `${method} ${path}`).toEqual(inPath.sort());
    }
  });

  it('marks signed-in routes as needing the session cookie, and lists 401 for them', async () => {
    const spec = (await generateSpec()) as Spec;

    for (const { path, method, operation } of operations(spec)) {
      const signedIn = operation['x-auth'] === 'user';
      expect(Boolean(operation.security), `${method} ${path}`).toBe(signedIn);
      expect(Boolean(operation.responses['401']), `${method} ${path}`).toBe(signedIn);
    }
  });

  it('only references schemas that exist', async () => {
    const spec = (await generateSpec()) as Spec;
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map(
      (match) => match[1],
    );
    const defined = Object.keys(spec.components['schemas'] ?? {});

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(defined).toContain(ref);
  });

  it('keeps bodies strict, as the server is', async () => {
    const spec = (await generateSpec()) as Spec;
    const create = spec.paths['/api/applications']?.['post'] as unknown as {
      requestBody: {
        content: {
          'application/json': { schema: { additionalProperties: boolean; required: string[] } };
        };
      };
    };
    const body = create.requestBody.content['application/json'].schema;

    expect(body.additionalProperties).toBe(false);
    expect(body.required.sort()).toEqual(['company', 'role']);
  });
});
