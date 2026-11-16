import { readFileSync } from 'node:fs';
import {
  acceptAnswer,
  ResumeAnalysisListSchema,
  ResumeAnalysisSchema,
  ResumeEnvelopeSchema,
  ResumeMatchSchema,
  ResumeSchema,
  type ResumeAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rateLimitKey } from '../auth/rateLimit';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import {
  AnalyzerUnavailableError,
  type AnalyzeOutcome,
  type PostingKeywordsOutcome,
} from '../resume/analyze';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import {
  ANALYSIS_GLOBAL_RULE,
  ANALYSIS_RULE,
  OWNER_ANALYSIS_RULE,
  UPLOAD_BODY_LIMIT,
} from './resume';

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
  postings: [] as string[],
  postingKeywords(text: string): Promise<PostingKeywordsOutcome> {
    this.postings.push(text);
    if (this.next === 'unavailable') return Promise.reject(new AnalyzerUnavailableError('bad key'));
    if (this.next === 'failed') return Promise.resolve({ kind: 'failed', reason: 'Declined' });
    const terms = ['Playwright', 'TypeScript', 'Kubernetes', 'Selenium', 'ISTQB'];
    return Promise.resolve({
      kind: 'keywords',
      answer: { keywords: terms.map((term) => ({ term, group: 'tool' as const })) },
      model: 'claude-opus-5-5',
    });
  },
};

const POSTING_URL = 'https://careers.example.com/jobs/sdet';
const POSTING_HTML = `<main><h1>Senior SDET</h1><p>${'We need Playwright and Selenium. '.repeat(10)}</p></main>`;
/** Job pages the tests may read; anything else fails like an unreachable site. */
const fetchPage: PageFetcher = (url) =>
  url === POSTING_URL
    ? Promise.resolve({ url, contentType: 'text/html', text: POSTING_HTML })
    : Promise.reject(new FetchError('network', 'tests never reach the network'));

describe.skipIf(!TEST_DATABASE_URL)('resume API (real app, real database)', () => {
  let t: TestApp;
  /** Read on every request, so a test can make a user the owner after signing in. */
  const env: Record<string, string | undefined> = { JOB_SEARCH_USER_IDS: '' };

  beforeAll(async () => {
    t = await createTestApp({ resumeAnalyzer: analyzer, fetchPage, env });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(() => {
    env['JOB_SEARCH_USER_IDS'] = '';
    analyzer.texts = [];
    analyzer.postings = [];
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
        analysesPerDay: ANALYSIS_RULE.limit,
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

    it('gives the stored text back to its owner only', async () => {
      const owner = await t.login();
      const text = pasted('text route');
      await upload(owner.cookie, { kind: 'text', text });
      const response = await send('GET', '/api/resume/text', owner.cookie);
      expect(response.json()).toEqual({ text: text.trim() });
      const other = await t.login();
      expect((await send('GET', '/api/resume/text', other.cookie)).statusCode).toBe(404);
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

    it('allows one analysis a day for most users', async () => {
      expect(ANALYSIS_RULE.limit).toBe(1);
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('day one') });
      expect((await analyse(cookie)).statusCode).toBe(201);

      await upload(cookie, { kind: 'text', text: pasted('one too many') });
      const refused = await analyse(cookie);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ message: 'You can run 1 resume analysis a day.' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(analyzer.texts).toHaveLength(1);

      // The next day it works again.
      t.clock.advance(25 * HOUR);
      expect((await analyse(cookie)).statusCode).toBe(201);
    });

    it('allows the owner 5 analyses a day, and says so', async () => {
      const owner = await t.login();
      env['JOB_SEARCH_USER_IDS'] = owner.user.id.toUpperCase();
      expect(parsed(ResumeEnvelopeSchema)(await send('GET', '/api/resume', owner.cookie))).toEqual({
        resume: null,
        analysisAvailable: true,
        analysesPerDay: OWNER_ANALYSIS_RULE.limit,
      });
      for (let index = 0; index < OWNER_ANALYSIS_RULE.limit; index += 1) {
        await upload(owner.cookie, { kind: 'text', text: pasted(`owner ${String(index)}`) });
        expect((await analyse(owner.cookie)).statusCode).toBe(201);
      }
      await upload(owner.cookie, { kind: 'text', text: pasted('owner one too many') });
      const refused = await analyse(owner.cookie);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ message: 'You can run 5 resume analyses a day.' });
      expect(analyzer.texts).toHaveLength(OWNER_ANALYSIS_RULE.limit);
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

    it('gives the daily attempt back when the analysis fails, so the user can try again', async () => {
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('retry after failure') });
      analyzer.next = 'failed';
      expect((await analyse(cookie)).statusCode).toBe(502);
      analyzer.next = 'unavailable';
      expect((await analyse(cookie)).statusCode).toBe(503);

      analyzer.next = 'ok';
      expect((await analyse(cookie)).statusCode).toBe(201);
      await upload(cookie, { kind: 'text', text: pasted('now the day is used') });
      expect((await analyse(cookie)).statusCode).toBe(429);
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

  describe('checking it against a posting (14c)', () => {
    const createApplication = async (cookie: string, jobLink: string | null) => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: { ...SAME_ORIGIN, cookie },
        payload: { company: 'Initech', role: 'Senior SDET', ...(jobLink ? { jobLink } : {}) },
      });
      return response.json<{ id: string }>().id;
    };
    const check = (cookie: string, id: string) =>
      send('POST', `/api/applications/${id}/resume-match`, cookie);

    it('reads the posting, and marks its keywords found or missing in the resume', async () => {
      const { cookie } = await t.login();
      await uploadFile(cookie, 'resume.pdf');
      const id = await createApplication(cookie, POSTING_URL);

      const response = await check(cookie, id);

      expect(response.statusCode).toBe(200);
      expect(parsed(ResumeMatchSchema)(response)).toEqual({
        jobLink: POSTING_URL,
        model: 'claude-opus-5-5',
        // The resume has Playwright, TypeScript, Kubernetes and Selenium, not ISTQB.
        keywords: [
          { term: 'Playwright', group: 'tool', found: true },
          { term: 'TypeScript', group: 'tool', found: true },
          { term: 'Kubernetes', group: 'tool', found: true },
          { term: 'Selenium', group: 'tool', found: true },
          { term: 'ISTQB', group: 'tool', found: false },
        ],
        found: 4,
        matchPercent: 80,
      });
      expect(analyzer.postings[0]).toContain('Senior SDET We need Playwright and Selenium.');
    });

    it('needs a job link and a resume, and explains an unreadable posting', async () => {
      const { cookie } = await t.login();
      const noLink = await createApplication(cookie, null);
      const deadLink = await createApplication(cookie, 'https://careers.example.com/gone');

      const noResume = await check(cookie, deadLink);
      expect(noResume.statusCode).toBe(409);

      await upload(cookie, { kind: 'text', text: pasted('match') });
      const missing = await check(cookie, noLink);
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ error: 'no_job_link' });
      const unreadable = await check(cookie, deadLink);
      expect(unreadable.statusCode).toBe(422);
      expect(unreadable.json()).toMatchObject({ error: 'no_posting_data' });
      expect(analyzer.postings).toEqual([]);
    });

    it('fails without saving when the keywords cannot be read', async () => {
      const { cookie } = await t.login();
      await upload(cookie, { kind: 'text', text: pasted('match fails') });
      const id = await createApplication(cookie, POSTING_URL);
      analyzer.next = 'failed';
      expect((await check(cookie, id)).statusCode).toBe(502);
    });

    it("answers 404 for someone else's application, and reads nothing", async () => {
      const owner = await t.login();
      const id = await createApplication(owner.cookie, POSTING_URL);
      const other = await t.login();
      await upload(other.cookie, { kind: 'text', text: pasted('other') });

      for (const target of [id, MISSING_ID, 'not-a-uuid']) {
        const response = await check(other.cookie, target);
        expect(response.statusCode, target).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found', message: 'Application not found' });
      }
      expect(analyzer.postings).toEqual([]);
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
