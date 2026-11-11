import {
  ApplicationTailoringSchema,
  DataExportSchema,
  type ApplicationTailorAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSearchClaude, TailorPostingRequest } from '../jobsearch/claude';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { TAILOR_RULE } from './jobSearch';

const RESUME = [
  'Pat Example',
  'Senior SDET',
  '- Built Playwright suites for checkout across 12 teams.',
  '- Ran SQL reports for the growth team.',
  '- Wrote test plans and release notes.',
  '- Kept flaky tests under one percent by quarantining and fixing them each week.',
  '- Paired with developers on contract tests for the payments and orders services.',
].join('\n');

const POSTING_LINK = 'https://careers.acme.example/jobs/1';
const POSTING_TEXT = `Senior SDET at Acme. ${'You will own Playwright and TypeScript suites, CI/CD, and SQL checks. '.repeat(6)}`;
const fetchPage: PageFetcher = (url) =>
  url === POSTING_LINK
    ? Promise.resolve({
        url,
        contentType: 'text/html',
        text: `<html><body><main><p>${POSTING_TEXT}</p></main></body></html>`,
      })
    : Promise.reject(new FetchError('network', 'test pages only'));

/** The model, stubbed: what it answers, and what it was asked. */
const model = {
  answer: null as ApplicationTailorAnswer | null,
  requests: [] as TailorPostingRequest[],
};
const ANSWER: ApplicationTailorAnswer = {
  keywords: ['Playwright', 'TypeScript', 'CI/CD', 'SQL', 'Kubernetes', 'test plans'].map(
    (term) => ({ term, group: 'tool' as const }),
  ),
  edits: [
    {
      original: '- Ran SQL reports for the growth team.',
      suggested: '- Ran SQL reports for the growth team, run in CI/CD.',
      keywordsAdded: ['CI/CD'],
      why: 'The reports ran in the pipeline.',
    },
    {
      // Not in the resume: dropped by code.
      original: '- Led a team of 40 engineers.',
      suggested: '- Led a team of 40 engineers using TypeScript.',
      keywordsAdded: ['TypeScript'],
      why: 'Invented.',
    },
  ],
  notCovered: [{ keyword: 'Kubernetes', why: 'No Kubernetes experience in the resume.' }],
};
const claude: JobSearchClaude = {
  search: () => Promise.resolve({ links: [], searches: 0 }),
  draft: () => Promise.resolve(null),
  tailor: () => Promise.resolve(null),
  leadMessage: () => Promise.resolve(null),
  coverLetter: () => Promise.resolve(null),
  tailorPosting: (request) => {
    model.requests.push(request);
    return Promise.resolve(model.answer);
  },
};

function parsed<T>(schema: { parse(value: unknown): T }) {
  return (response: LightMyRequestResponse): T => {
    expect(response.statusCode, response.body).toBe(200);
    return schema.parse(response.json());
  };
}
const tailoringOf = parsed(ApplicationTailoringSchema);

describe.skipIf(!TEST_DATABASE_URL)(
  'a resume tailored to an application (real app, real database)',
  () => {
    let t: TestApp;
    const env: Record<string, string> = { JOB_SEARCH_USER_IDS: '' };

    beforeAll(async () => {
      t = await createTestApp({ env, jobSearchClaude: claude, fetchPage });
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      model.answer = ANSWER;
      model.requests = [];
      t.clock.set(T0);
      await t.db.query("delete from rate_limits where key like 'job-search-tailor%'");
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
        ...(payload ? { payload } : method === 'POST' || method === 'PUT' ? { payload: {} } : {}),
      });

    /** An allowed user with the resume and one application (with the posting link by default). */
    async function owner(options: { jobLink?: string | null; resume?: boolean } = {}) {
      const login = await t.login();
      env['JOB_SEARCH_USER_IDS'] = [env['JOB_SEARCH_USER_IDS'], login.user.id]
        .filter(Boolean)
        .join(',');
      if (options.resume !== false)
        await send('PUT', '/api/resume', login.cookie, { kind: 'text', text: RESUME });
      const jobLink = options.jobLink === undefined ? POSTING_LINK : options.jobLink;
      const application = (
        await send('POST', '/api/applications', login.cookie, {
          company: 'Acme',
          role: 'Senior SDET',
          status: 'Saved',
          ...(jobLink ? { jobLink } : {}),
        })
      ).json<{ id: string }>();
      return { ...login, id: application.id };
    }
    const tailor = (cookie: string, id: string, body?: object) =>
      send('POST', `/api/applications/${id}/tailor`, cookie, body);
    const read = (cookie: string, id: string) =>
      send('GET', `/api/applications/${id}/tailoring`, cookie);
    const save = (cookie: string, id: string, text: string) =>
      send('PUT', `/api/applications/${id}/tailored-resume`, cookie, { text });
    const remove = (cookie: string, id: string) =>
      send('DELETE', `/api/applications/${id}/tailored-resume`, cookie);

    it('tailors from the job link: checked suggestions, the posting keywords, stored', async () => {
      const me = await owner();
      expect(tailoringOf(await read(me.cookie, me.id))).toEqual({
        tailoring: null,
        keywords: [],
        hasPostingText: false,
        saved: null,
      });

      const result = tailoringOf(await tailor(me.cookie, me.id));

      expect(model.requests[0]).toMatchObject({ company: 'Acme', role: 'Senior SDET' });
      expect(model.requests[0]?.postingText).toContain('Playwright and TypeScript suites');
      expect(result.hasPostingText).toBe(true);
      expect(result.keywords.map((keyword) => keyword.term)).toEqual([
        'Playwright',
        'TypeScript',
        'CI/CD',
        'SQL',
        'Kubernetes',
        'test plans',
      ]);
      // The invented line is dropped. The real one is the resume's own text, and CI/CD, a tool
      // the resume never mentions, is flagged for the owner to check (as in Phase 16).
      expect(result.tailoring?.edits).toEqual([
        {
          original: 'Ran SQL reports for the growth team.',
          suggested: '- Ran SQL reports for the growth team, run in CI/CD.',
          keywordsAdded: ['CI/CD'],
          why: 'The reports ran in the pipeline.',
          unverified: ['CI/CD'],
        },
      ]);
      expect(result.tailoring?.notCovered).toEqual(ANSWER.notCovered);
      expect(tailoringOf(await read(me.cookie, me.id))).toEqual(result);

      // Tailoring again uses the stored posting: no link read, same keywords.
      tailoringOf(await tailor(me.cookie, me.id));
      expect(model.requests[1]?.postingText).toBe(model.requests[0]?.postingText);
    });

    it('asks for the posting when the link cannot be read, then tailors from the paste', async () => {
      const linkedIn = await owner({ jobLink: 'https://www.linkedin.com/jobs/view/123' });
      const unreadable = await tailor(linkedIn.cookie, linkedIn.id);
      expect(unreadable.statusCode).toBe(422);
      expect(unreadable.json()).toMatchObject({ error: 'posting_unreadable' });

      const noLink = await owner({ jobLink: null });
      expect((await tailor(noLink.cookie, noLink.id)).json()).toMatchObject({
        error: 'no_job_link',
      });
      expect(model.requests).toHaveLength(0);

      const pasted = tailoringOf(
        await tailor(noLink.cookie, noLink.id, { postingText: POSTING_TEXT }),
      );
      expect(model.requests[0]?.postingText).toBe(POSTING_TEXT.trim());
      expect(pasted.hasPostingText).toBe(true);
      // Too short to be a posting.
      expect((await tailor(noLink.cookie, noLink.id, { postingText: 'SDET' })).statusCode).toBe(
        400,
      );
    });

    it('answers 502 when the suggestions do not finish, and 409 without a resume', async () => {
      const me = await owner();
      model.answer = null;
      expect((await tailor(me.cookie, me.id)).json()).toMatchObject({ error: 'tailor_failed' });
      const noResume = await owner({ resume: false });
      expect((await tailor(noResume.cookie, noResume.id)).json()).toMatchObject({
        error: 'no_resume',
      });
    });

    it('shares the daily tailoring limit', async () => {
      const me = await owner();
      for (let index = 0; index < TAILOR_RULE.limit; index += 1)
        expect((await tailor(me.cookie, me.id)).statusCode).toBe(200);
      expect((await tailor(me.cookie, me.id)).statusCode).toBe(429);
    });

    it("saves this job's resume with its changes, flags a replaced resume, and removes it", async () => {
      const me = await owner();
      await tailor(me.cookie, me.id);
      const edited = RESUME.replace(
        '- Ran SQL reports for the growth team.',
        '- Ran SQL reports for the growth team, run in CI/CD.',
      ).replace('- Wrote test plans and release notes.', '- Wrote test plans for each release.');

      const saved = tailoringOf(await save(me.cookie, me.id, edited));

      expect(saved.saved).toMatchObject({ text: edited, resumeChanged: false });
      expect(saved.saved?.edits).toEqual([
        {
          original: '- Ran SQL reports for the growth team.',
          replacement: '- Ran SQL reports for the growth team, run in CI/CD.',
        },
        {
          original: '- Wrote test plans and release notes.',
          replacement: '- Wrote test plans for each release.',
        },
      ]);
      // The suggestions are kept beside it.
      expect(saved.tailoring?.edits).toHaveLength(1);

      // A new resume does not change the saved version, but it is flagged.
      await send('PUT', '/api/resume', me.cookie, { kind: 'text', text: `${RESUME}\n- New line.` });
      const later = tailoringOf(await read(me.cookie, me.id));
      expect(later.saved).toMatchObject({ text: edited, resumeChanged: true });

      const removed = tailoringOf(await remove(me.cookie, me.id));
      expect(removed.saved).toBeNull();
      expect(removed.tailoring?.edits).toHaveLength(1);
    });

    it('saves a version written by hand, with no tailoring first', async () => {
      const me = await owner();
      const saved = tailoringOf(await save(me.cookie, me.id, `${RESUME}\n- Mentored two testers.`));
      expect(saved).toMatchObject({ tailoring: null, keywords: [] });
      expect(saved.saved?.edits).toEqual([
        { original: '', replacement: '- Mentored two testers.' },
      ]);
    });

    it('is in the data export, and goes with the application', async () => {
      const me = await owner();
      await tailor(me.cookie, me.id);
      await save(me.cookie, me.id, `${RESUME}\n- Mentored two testers.`);
      const exported = DataExportSchema.parse(
        (await send('GET', '/api/me/export', me.cookie)).json(),
      );
      expect(exported.applicationTailorings).toHaveLength(1);
      expect(exported.applicationTailorings[0]).toMatchObject({
        applicationId: me.id,
        tailoring: { saved: { text: `${RESUME}\n- Mentored two testers.` } },
      });
      expect(exported.applicationTailorings[0]?.postingText).toContain('Playwright');

      await send('DELETE', `/api/applications/${me.id}`, me.cookie);
      const left = await t.db.query(
        'select 1 from application_tailorings where application_id = $1',
        [me.id],
      );
      expect(left.rowCount).toBe(0);
    });

    it("gives another user 404 for someone else's application, and changes nothing", async () => {
      const me = await owner();
      await tailor(me.cookie, me.id);
      await save(me.cookie, me.id, RESUME);
      const other = await owner();
      for (const id of [me.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
        for (const response of [
          await read(other.cookie, id),
          await tailor(other.cookie, id),
          await save(other.cookie, id, 'Mine now'),
          await remove(other.cookie, id),
        ]) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: 'not_found' });
        }
      }
      expect(tailoringOf(await read(me.cookie, me.id)).saved?.text).toBe(RESUME);
      expect(model.requests).toHaveLength(1);
    });

    it('is not available (404) to a user who is not on the list', async () => {
      const stranger = await t.login();
      const application = (
        await send('POST', '/api/applications', stranger.cookie, { company: 'Acme', role: 'SDET' })
      ).json<{ id: string }>();
      const response = await read(stranger.cookie, application.id);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'not_available' });
    });
  },
);
