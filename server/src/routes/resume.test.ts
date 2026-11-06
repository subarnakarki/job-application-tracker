import { readFileSync } from 'node:fs';
import {
  acceptAnswer,
  ResumeAnalysisListSchema,
  ResumeAnalysisSchema,
  ResumeEnvelopeSchema,
  ResumeSchema,
  type ResumeAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rateLimitKey } from '../auth/rateLimit';
import { AnalyzerUnavailableError, type AnalyzeOutcome } from '../resume/analyze';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { ANALYSIS_GLOBAL_RULE, ANALYSIS_RULE, UPLOAD_BODY_LIMIT } from './resume';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const HOUR = 60 * 60 * 1000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const fixture = (name: string) =>
  readFileSync(new URL(`../resume/fixtures/${name}`, import.meta.url)).toString('base64');

/** Pasted resume text, long enough to be accepted, made unique by `tag`. */
const pasted = (tag: string) =>
  `Pat Example (${tag}). Senior SDET with Playwright, TypeScript and CI/CD. `.repeat(4);

function parsed<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }) {
  return (response: LightMyRequestResponse): T => {
    const result = schema.safeParse(response.json());
    if (!result.success || result.data === undefined)
      throw new Error(`Response broke the contract: ${response.body}`);
    return result.data;
  };
}
const analysisOf = parsed(ResumeAnalysisSchema);

const answer: ResumeAnswer = {
  summary: 'A senior SDET.',
  titles: Array.from({ length: 20 }, (_, index) => ({
    title: `Title ${index + 1}`,
    fit: 'good',
    seniority: 'Senior',
    reason: 'Eight years of automation.',
    keywords: [
      { term: 'Playwright', group: 'tool' },
      { term: 'Selenium', group: 'tool' },
    ],
  })),
  gaps: [],
  warnings: [],
};

/** A stub analyzer whose next answer each test chooses; it records the texts it was given. */
const analyzer = {
  texts: [] as string[],
  next: 'ok' as 'ok' | 'failed' | 'unavailable',
  analyze(text: string): Promise<AnalyzeOutcome> {
    this.texts.push(text);
    if (this.next === 'unavailable') return Promise.reject(new AnalyzerUnavailableError('bad key'));
    if (this.next === 'failed') return Promise.resolve({ kind: 'failed', reason: 'Declined' });
    const result = acceptAnswer(answer, text);
    if (!result) throw new Error('fixture answer was refused');
    return Promise.resolve({ kind: 'result', result, model: 'claude-opus-5-5' });
  },
};

describe.skipIf(!TEST_DATABASE_URL)('resume API (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ resumeAnalyzer: analyzer });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    analyzer.texts = [];
    analyzer.next = 'ok';
  });

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    cookie: string,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie },
      ...(payload ? { payload } : method === 'POST' ? { payload: {} } : {}),
    });
  const upload = (cookie: string, body: object) => send('PUT', '/api/resume', cookie, body);
  const uploadFile = (cookie: string, name: string, fileName = name) =>
    upload(cookie, { kind: 'file', fileName, dataBase64: fixture(name) });
  const analyse = (cookie: string) => send('POST', '/api/resume/analyses', cookie);

  describe('the resume itself', () => {
    it('starts empty, says analysis is on, then stores a PDF and gives the file back', async () => {
      const { cookie } = await t.login();
      expect(parsed(ResumeEnvelopeSchema)(await send('GET', '/api/resume', cookie))).toEqual({
        resume: null,
        analysisAvailable: true,
      });

      const uploaded = await uploadFile(cookie, 'resume.pdf', 'Pat CV.pdf');
      expect(uploaded.statusCode).toBe(200);
      expect(parsed(ResumeSchema)(uploaded)).toMatchObject({
        fileName: 'Pat CV.pdf',
        mediaType: 'application/pdf',
        uploadedAt: t.clock.now().toISOString(),
      });

      const file = await send('GET', '/api/resume/file', cookie);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="Pat CV.pdf"; filename*=UTF-8''Pat%20CV.pdf`,
      );
      expect(file.rawPayload.toString('base64')).toBe(fixture('resume.pdf'));
    });

    it('replaces the resume with a DOCX, or with pasted text (which has no file)', async () => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.pdf');
      expect(parsed(ResumeSchema)(await uploadFile(cookie, 'resume.docx')).mediaType).toBe(DOCX);

      const text = await upload(cookie, { kind: 'text', text: pasted('paste') });
      expect(parsed(ResumeSchema)(text)).toMatchObject({ fileName: null, mediaType: 'text/plain' });
      expect((await send('GET', '/api/resume/file', cookie)).statusCode).toBe(404);
    });

    it.each([
      ['a PNG named .pdf', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 415, 'unsupported_type'],
      ['a scanned PDF', fixture('scanned.pdf'), 422, 'no_text'],
      ['a 12-page PDF', fixture('twelve-pages.pdf'), 422, 'too_many_pages'],
      [
        'a file just over 2 MB',
        Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024)]).toString(
          'base64',
        ),
        413,
        'too_large',
      ],
    ])('refuses %s, and keeps the resume it had', async (_label, dataBase64, status, code) => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.docx');

      const response = await upload(cookie, { kind: 'file', fileName: 'cv.pdf', dataBase64 });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: code });
      expect(
        parsed(ResumeEnvelopeSchema)(await send('GET', '/api/resume', cookie)).resume?.mediaType,
      ).toBe(DOCX);
    });

    it('refuses a body over the upload limit before reading it', async () => {
      const { cookie } = await t.login();
      const response = await t.app.inject({
        method: 'PUT',
        url: '/api/resume',
        headers: { ...SAME_ORIGIN, cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ kind: 'text', text: 'x'.repeat(UPLOAD_BODY_LIMIT) }),
      });
      expect(response.statusCode).toBe(413);
    });

    it('deletes the resume', async () => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.pdf');
      expect((await send('DELETE', '/api/resume', cookie)).statusCode).toBe(204);
      expect(parsed(ResumeEnvelopeSchema)(await send('GET', '/api/resume', cookie)).resume).toBe(
        null,
      );
    });

    it('is closed to the shared demo account', async () => {
      const { cookie } = await t.login({ isDemo: true });
      const response = await uploadFile(cookie, 'resume.pdf');
      expect(response.statusCode).toBe(403);
      expect((await analyse(cookie)).statusCode).toBe(403);
    });
  });

  describe('analysing it', () => {
    it('needs a resume first', async () => {
      const { cookie } = await t.login();
      const response = await analyse(cookie);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'no_resume' });
    });

    it('sends the resume text, saves 20 ranked titles, and marks keywords by code', async () => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.pdf');

      const response = await analyse(cookie);

      expect(response.statusCode).toBe(201);
      const analysis = analysisOf(response);
      expect(response.headers['location']).toBe(`/api/resume/analyses/${analysis.id}`);
      expect(analyzer.texts).toHaveLength(1);
      expect(analyzer.texts[0]).toContain('Senior Software Engineer in Test');
      expect(analysis.titles).toHaveLength(20);
      // The resume has Playwright and Selenium.
      expect(analysis.titles[0]?.keywords.every((keyword) => keyword.found)).toBe(true);
      expect(analysisOf(await send('GET', `/api/resume/analyses/${analysis.id}`, cookie))).toEqual(
        analysis,
      );
    });

    it('answers the same resume again from the saved analysis for a day', async () => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.docx');
      const first = analysisOf(await analyse(cookie));

      // Uploading the same file again keeps the same text, so the same answer.
      await uploadFile(cookie, 'resume.docx');
      const again = await analyse(cookie);
      expect(again.statusCode).toBe(200);
      expect(analysisOf(again).id).toBe(first.id);
      expect(analyzer.texts).toHaveLength(1);

      t.clock.advance(25 * HOUR);
      const later = await analyse(cookie);
      expect(later.statusCode).toBe(201);
      expect(analysisOf(later).id).not.toBe(first.id);
    });

    it('allows 5 analyses a day per user', async () => {
      const { cookie } = await t.login();
      for (let index = 0; index < ANALYSIS_RULE.limit; index += 1) {
        await upload(cookie, { kind: 'text', text: pasted(`day ${String(index)}`) });
        expect((await analyse(cookie)).statusCode).toBe(201);
      }
      await upload(cookie, { kind: 'text', text: pasted('one too many') });
      const refused = await analyse(cookie);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(analyzer.texts).toHaveLength(ANALYSIS_RULE.limit);
    });

    it('keeps only the 5 newest analyses', async () => {
      const { cookie } = await t.login();
      for (let index = 0; index < 7; index += 1) {
        // A day apart, so the daily limit never applies.
        t.clock.advance(25 * HOUR);
        await upload(cookie, { kind: 'text', text: pasted(`keep ${String(index)}`) });
        expect((await analyse(cookie)).statusCode).toBe(201);
      }
      const list = parsed(ResumeAnalysisListSchema)(
        await send('GET', '/api/resume/analyses', cookie),
      );
      expect(list.items).toHaveLength(5);
      expect(list.items[0]?.topTitles).toEqual(['Title 1', 'Title 2', 'Title 3']);
      const created = list.items.map((item) => item.createdAt);
      expect(created).toEqual([...created].sort().reverse());
    });

    it('stops everyone once the daily total is reached', async () => {
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('global') });
      const windowStart = Math.floor(t.clock.now().getTime() / ANALYSIS_GLOBAL_RULE.windowMs);
      await t.db.query(
        `insert into rate_limits (key, window_start, count) values ($1, $2, $3)
          on conflict (key, window_start) do update set count = excluded.count`,
        [
          rateLimitKey(ANALYSIS_GLOBAL_RULE.name, 'all'),
          new Date(windowStart * ANALYSIS_GLOBAL_RULE.windowMs),
          ANALYSIS_GLOBAL_RULE.limit,
        ],
      );
      try {
        expect((await analyse(cookie)).statusCode).toBe(429);
        expect(analyzer.texts).toHaveLength(0);
      } finally {
        await t.db.query('delete from rate_limits where key = $1', [
          rateLimitKey(ANALYSIS_GLOBAL_RULE.name, 'all'),
        ]);
      }
    });

    it('saves nothing when the analysis fails, and says when the key is rejected', async () => {
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('fails') });

      analyzer.next = 'failed';
      const failed = await analyse(cookie);
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({ error: 'analysis_failed' });

      analyzer.next = 'unavailable';
      expect((await analyse(cookie)).statusCode).toBe(503);
      expect(
        parsed(ResumeAnalysisListSchema)(await send('GET', '/api/resume/analyses', cookie)).items,
      ).toEqual([]);
    });

    it('deletes an analysis', async () => {
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('delete me') });
      const { id } = analysisOf(await analyse(cookie));

      expect((await send('DELETE', `/api/resume/analyses/${id}`, cookie)).statusCode).toBe(204);
      expect((await send('GET', `/api/resume/analyses/${id}`, cookie)).statusCode).toBe(404);
      expect((await send('DELETE', `/api/resume/analyses/${id}`, cookie)).statusCode).toBe(404);
    });
  });

  describe('the data export', () => {
    it('describes the resume and includes its analyses, but never the resume text', async () => {
      const { cookie } = await t.login();
      const text = pasted('exported');
      await upload(cookie, { kind: 'text', text });
      const analysis = analysisOf(await analyse(cookie));

      const exported = await send('GET', '/api/me/export', cookie);
      expect(exported.statusCode).toBe(200);
      expect(exported.json()).toMatchObject({
        resume: { fileName: null, mediaType: 'text/plain', characters: text.trim().length },
        resumeAnalyses: [analysis],
      });
      expect(exported.body).not.toContain('Pat Example (exported)');
    });
  });

  describe('isolation between users', () => {
    it("answers 404 for someone else's analysis, a missing one, or a bad id, and changes nothing", async () => {
      const owner = await t.login();
      await upload(owner.cookie, { kind: 'text', text: pasted('owner') });
      const { id } = analysisOf(await analyse(owner.cookie));
      const other = await t.login();

      for (const target of [id, MISSING_ID, 'not-a-uuid']) {
        for (const method of ['GET', 'DELETE'] as const) {
          const response = await send(method, `/api/resume/analyses/${target}`, other.cookie);
          expect(response.statusCode, `${method} ${target}`).toBe(404);
          expect(response.json()).toEqual({ error: 'not_found', message: 'Analysis not found' });
        }
      }
      expect(
        parsed(ResumeAnalysisListSchema)(await send('GET', '/api/resume/analyses', other.cookie))
          .items,
      ).toEqual([]);
      expect((await send('GET', `/api/resume/analyses/${id}`, owner.cookie)).statusCode).toBe(200);
    });

    it("never serves someone else's resume file", async () => {
      const owner = await t.login();
      await uploadFile(owner.cookie, 'resume.pdf');
      const other = await t.login();
      expect((await send('GET', '/api/resume/file', other.cookie)).statusCode).toBe(404);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('resume API without an analyzer configured', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('still stores resumes, but says analysis is off', async () => {
    const { cookie } = await t.login();
    const headers = { ...SAME_ORIGIN, cookie };
    await t.app.inject({
      method: 'PUT',
      url: '/api/resume',
      headers,
      payload: { kind: 'text', text: pasted('no analyzer') },
    });
    expect(
      parsed(ResumeEnvelopeSchema)(
        await t.app.inject({ method: 'GET', url: '/api/resume', headers }),
      ),
    ).toMatchObject({ analysisAvailable: false });

    const response = await t.app.inject({
      method: 'POST',
      url: '/api/resume/analyses',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_available' });
  });
});
