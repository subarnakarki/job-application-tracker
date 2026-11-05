import { PipelineSchema } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)(
  'pipeline counts and CSV export (real app, real database)',
  () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => {
      await t.close();
    });

    const create = (cookie: string, payload: Record<string, unknown>) =>
      t.app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: { ...SAME_ORIGIN, cookie },
        payload: { role: 'SDET', ...payload },
      });
    const get = (cookie: string, url: string) =>
      t.app.inject({ method: 'GET', url, headers: { cookie } });

    describe('GET /api/pipeline', () => {
      it('counts every stage (zeros included), the follow-ups and the total, for this user only', async () => {
        const me = await t.login();
        const other = await t.login();
        await create(me.cookie, { company: 'A', status: 'Applied' });
        await create(me.cookie, { company: 'B', status: 'Applied' });
        await create(me.cookie, { company: 'C', status: 'Offer' });
        await create(other.cookie, { company: 'X', status: 'Applied' });
        t.clock.advance(8 * DAY);
        try {
          const body = PipelineSchema.parse((await get(me.cookie, '/api/pipeline')).json());

          expect(
            Object.fromEntries(body.stages.map((stage) => [stage.status, stage.count])),
          ).toEqual({
            Saved: 0,
            Applied: 2,
            Screening: 0,
            Interviewing: 0,
            Offer: 1,
            Rejected: 0,
            Withdrawn: 0,
          });
          expect(body.followUpCount).toBe(2); // the two stale Applied ones; Offer never needs follow-up
          expect(body.total).toBe(3);
        } finally {
          t.clock.advance(-8 * DAY);
        }
      });

      it('respects the search', async () => {
        const { cookie } = await t.login();
        await create(cookie, { company: 'Acme', status: 'Applied' });
        await create(cookie, { company: 'Globex', status: 'Screening' });

        const body = PipelineSchema.parse((await get(cookie, '/api/pipeline?q=acme')).json());

        expect(body.total).toBe(1);
        expect(body.stages.find((stage) => stage.status === 'Applied')?.count).toBe(1);
      });

      it('rejects a stage filter, so the bar always shows every stage', async () => {
        const { cookie } = await t.login();

        expect((await get(cookie, '/api/pipeline?status=Applied')).statusCode).toBe(400);
      });
    });

    describe('GET /api/applications/export.csv', () => {
      it('downloads the listed applications as CSV, with the same filters, for this user only', async () => {
        const me = await t.login({ timeZone: 'America/New_York' });
        const other = await t.login();
        await create(me.cookie, {
          company: 'Acme, Inc.',
          status: 'Applied',
          notes: 'Said "great fit"',
        });
        await create(me.cookie, { company: 'Globex', status: 'Offer' });
        await create(me.cookie, { company: '=HYPERLINK("http://evil")', status: 'Applied' });
        await create(other.cookie, { company: 'Theirs', status: 'Applied' });

        const response = await get(
          me.cookie,
          '/api/applications/export.csv?status=Applied&sort=company_asc',
        );

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(response.headers['content-disposition']).toBe(
          'attachment; filename="applications-2026-11-05.csv"',
        );
        expect(response.body.startsWith('﻿Company,Role,Status,')).toBe(true);
        const lines = response.body.slice(1).trimEnd().split('\r\n');
        expect(lines).toHaveLength(3); // header + the two Applied ones
        expect(lines[1]).toContain('"\'=HYPERLINK(""http://evil"")"'); // a formula is defused
        expect(lines[2]).toMatch(/^"Acme, Inc\.",SDET,Applied,2026-11-05,/);
        expect(lines[2]).toContain('"Said ""great fit"""');
        expect(response.body).not.toContain('Globex');
        expect(response.body).not.toContain('Theirs');
      });

      it('is not available to the shared demo account', async () => {
        const { cookie } = await t.login({ isDemo: true });

        expect((await get(cookie, '/api/applications/export.csv')).statusCode).toBe(403);
      });

      it('needs a session', async () => {
        expect(
          (await t.app.inject({ method: 'GET', url: '/api/applications/export.csv' })).statusCode,
        ).toBe(401);
      });
    });
  },
);
