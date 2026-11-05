import { ErrorSchema } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { ROUTE_NOT_FOUND } from './contractValidation';

const Thing = z.strictObject({ id: z.number(), name: z.string() });

/** An app with response validation on and a few routes that keep or break their contracts. */
async function appWith(routes: (app: ReturnType<typeof buildApp>) => void) {
  const app = buildApp({ validateResponses: true });
  routes(app);
  await app.ready();
  return app;
}

const contract = (responses: Record<number, z.ZodType | null>) => ({
  auth: 'public' as const,
  contract: { summary: 'test', responses },
});

describe('contract validation (test mode)', () => {
  it('lets a response that matches its contract through untouched', async () => {
    const app = await appWith((a) =>
      a.get('/api/ok', { config: contract({ 200: Thing }) }, () => ({ id: 1, name: 'x' })),
    );

    const response = await app.inject({ method: 'GET', url: '/api/ok' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 1, name: 'x' });
    expect(app.contractViolations).toEqual([]);
  });

  it.each([
    ['an extra field (a leak)', () => ({ id: 1, name: 'x', userId: 'secret' }), 'Unrecognized key'],
    ['a missing field', () => ({ id: 1 }), 'name'],
    ['a wrong type', () => ({ id: '1', name: 'x' }), 'id'],
  ])(
    'turns a body with %s into a 500 that explains the violation, and records it',
    async (_label, handler, hint) => {
      const app = await appWith((a) =>
        a.get('/api/bad', { config: contract({ 200: Thing }) }, handler),
      );

      const response = await app.inject({ method: 'GET', url: '/api/bad' });

      expect(response.statusCode).toBe(500);
      expect(response.json<{ error: string; message: string }>().error).toBe('contract_violation');
      expect(response.json<{ message: string }>().message).toContain(hint);
      expect(app.contractViolations).toHaveLength(1);
      expect(app.contractViolations[0]).toMatchObject({
        method: 'GET',
        url: '/api/bad',
        status: 200,
      });
    },
  );

  it('flags a success status the route never declared', async () => {
    const app = await appWith((a) =>
      a.post('/api/make', { config: contract({ 201: Thing }) }, (_request, reply) =>
        reply.code(200).send({ id: 1, name: 'x' }),
      ),
    );

    const response = await app.inject({ method: 'POST', url: '/api/make' });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ message: string }>().message).toContain('not declared');
  });

  it('flags a body on a no-body status, and a missing body on a body status', async () => {
    const app = await appWith((a) => {
      a.delete('/api/gone', { config: contract({ 204: null }) }, (_request, reply) =>
        reply.code(204).send('surprise'),
      );
      a.get('/api/empty', { config: contract({ 200: Thing }) }, (_request, reply) =>
        reply.code(200).send(),
      );
    });

    expect((await app.inject({ method: 'DELETE', url: '/api/gone' })).statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/api/empty' })).statusCode).toBe(500);
    expect(app.contractViolations.map((violation) => violation.problem)).toEqual([
      'the route declares no body for this status, but sent one',
      'the route declares a body for this status, but sent none',
    ]);
  });

  it('accepts a declared no-body 204', async () => {
    const app = await appWith((a) =>
      a.delete('/api/gone', { config: contract({ 204: null }) }, (_request, reply) =>
        reply.code(204).send(),
      ),
    );

    expect((await app.inject({ method: 'DELETE', url: '/api/gone' })).statusCode).toBe(204);
    expect(app.contractViolations).toEqual([]);
  });

  it('holds every undeclared error body to the shared error shape', async () => {
    const app = await appWith((a) => {
      a.get('/api/good-error', { config: contract({ 200: Thing }) }, (_request, reply) =>
        reply.code(409).send({ error: 'conflict', message: 'x' }),
      );
      a.get('/api/bad-error', { config: contract({ 200: Thing }) }, (_request, reply) =>
        reply.code(409).send({ statusCode: 409, msg: 'x' }),
      );
    });

    expect((await app.inject({ method: 'GET', url: '/api/good-error' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/bad-error' })).statusCode).toBe(500);
  });

  it('uses a route-specific schema for a declared error status instead of the shared one', async () => {
    const Health = z.strictObject({ status: z.literal('unavailable') });
    const app = await appWith((a) =>
      a.get('/api/maybe', { config: contract({ 200: Thing, 503: Health }) }, (_request, reply) =>
        reply.code(503).send({ status: 'unavailable' }),
      ),
    );

    expect((await app.inject({ method: 'GET', url: '/api/maybe' })).statusCode).toBe(503);
  });

  it('flags a body that is not JSON', async () => {
    const app = await appWith((a) =>
      a.get('/api/text', { config: contract({ 200: Thing }) }, (_request, reply) =>
        reply.header('content-type', 'text/plain').send('hello'),
      ),
    );

    const response = await app.inject({ method: 'GET', url: '/api/text' });

    expect(response.statusCode).toBe(500);
    expect(app.contractViolations[0]?.problem).toBe('the body is not JSON');
  });

  it('checks the errors the pipeline itself sends (401, 403, 415) and the 404 for unknown routes', async () => {
    const app = await appWith((a) =>
      a.post('/api/x', { config: { ...contract({ 200: Thing }), auth: 'user' } }, () => ({
        id: 1,
        name: 'x',
      })),
    );

    const unauthenticated = await app.inject({ method: 'POST', url: '/api/x' });
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/x',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const plain = await app.inject({
      method: 'POST',
      url: '/api/x',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    const unknown = await app.inject({ method: 'GET', url: '/api/nowhere' });

    expect([
      unauthenticated.statusCode,
      crossSite.statusCode,
      plain.statusCode,
      unknown.statusCode,
    ]).toEqual([401, 403, 415, 404]);
    expect(unknown.json()).toEqual(ROUTE_NOT_FOUND);
    expect(ErrorSchema.safeParse(unknown.json()).success).toBe(true);
    expect(app.contractViolations).toEqual([]);
  });

  it('is off unless asked for, so production pays nothing', async () => {
    const app = buildApp();
    app.get('/api/bad', { config: contract({ 200: Thing }) }, () => ({ nope: true }));

    const response = await app.inject({ method: 'GET', url: '/api/bad' });

    expect(response.statusCode).toBe(200);
    expect(app.hasDecorator('contractViolations')).toBe(false);
  });
});
