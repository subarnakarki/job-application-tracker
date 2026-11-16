import {
  ApplicationCoverLetterSchema,
  DataExportSchema,
  type CoverLetterAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalyzerUnavailableError } from '../resume/analyze';
import { ClaudeLimitError } from '../anthropic/limits';
import type { CoverLetterModelRequest, JobSearchClaude } from '../jobsearch/claude';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { COVER_LETTER_RULE } from './coverLetters';

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
const links = { read: 0 };
const fetchPage: PageFetcher = (url) => {
  links.read += 1;
  return url === POSTING_LINK
    ? Promise.resolve({
        url,
        contentType: 'text/html',
        text: `<html><body><main><p>${POSTING_TEXT}</p></main></body></html>`,
      })
    : Promise.reject(new FetchError('network', 'test pages only'));
};

const LETTER =
  'Dear Jane Doe,\n\nI built Playwright suites across 12 teams.\n\nSincerely,\nPat Example';

/** The model, stubbed: what it answers (one per call, the last repeated), and what it was asked. */
const model = {
  answers: [] as (CoverLetterAnswer | null | 'unavailable' | ClaudeLimitError)[],
  requests: [] as CoverLetterModelRequest[],
};
const claude: JobSearchClaude = {
  search: () => Promise.resolve({ links: [], searches: 0 }),
  draft: () => Promise.resolve(null),
  tailor: () => Promise.resolve(null),
  leadMessage: () => Promise.resolve(null),
  tailorPosting: () => Promise.resolve({ keywords: [], edits: [], notCovered: [] }),
  coverLetter: (request) => {
    model.requests.push(request);
    const answer = model.answers[Math.min(model.requests.length, model.answers.length) - 1];
    if (answer === 'unavailable') return Promise.reject(new AnalyzerUnavailableError('no key'));
    if (answer instanceof ClaudeLimitError) return Promise.reject(answer);
    return Promise.resolve(answer ?? null);
  },
};

function parsed<T>(schema: { parse(value: unknown): T }) {
  return (response: LightMyRequestResponse): T => {
    expect(response.statusCode, response.body).toBe(200);
    return schema.parse(response.json());
  };
}
const letterOf = parsed(ApplicationCoverLetterSchema);

describe.skipIf(!TEST_DATABASE_URL)(
  'a cover letter for an application (real app, real database)',
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
      model.answers = [{ letter: LETTER }];
      model.requests = [];
      links.read = 0;
      t.clock.set(T0);
      await t.db.query("delete from rate_limits where key like 'cover-letter%'");
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
    async function owner(
      options: { jobLink?: string | null; resume?: boolean; contact?: string } = {},
    ) {
      const login = await t.login();
      env['JOB_SEARCH_USER_IDS'] = [env['JOB_SEARCH_USER_IDS'], login.user.id]
        .filter(Boolean)
        .join(',');
      if (options.resume !== false)
        expect(
          (await send('PUT', '/api/resume', login.cookie, { kind: 'text', text: RESUME }))
            .statusCode,
        ).toBe(200);
      const jobLink = options.jobLink === undefined ? POSTING_LINK : options.jobLink;
      const application = (
        await send('POST', '/api/applications', login.cookie, {
          company: 'Acme',
          role: 'Senior SDET',
          status: 'Saved',
          ...(jobLink ? { jobLink } : {}),
          ...(options.contact ? { contact: options.contact } : {}),
        })
      ).json<{ id: string }>();
      return { ...login, id: application.id };
    }
    const read = (cookie: string, id: string) =>
      send('GET', `/api/applications/${id}/cover-letter`, cookie);
    const draft = (cookie: string, id: string, body?: object) =>
      send('POST', `/api/applications/${id}/cover-letter/draft`, cookie, body);
    const save = (cookie: string, id: string, text: string) =>
      send('PUT', `/api/applications/${id}/cover-letter`, cookie, { text });
    const remove = (cookie: string, id: string) =>
      send('DELETE', `/api/applications/${id}/cover-letter`, cookie);

    it('drafts from the job link in the tone and length chosen, and keeps it as a draft', async () => {
      const me = await owner({ contact: 'Jane Doe, recruiter' });
      expect(letterOf(await read(me.cookie, me.id))).toEqual({
        coverLetter: null,
        hasPostingText: false,
      });

      const result = letterOf(
        await draft(me.cookie, me.id, { tone: 'warm', length: 'short', steer: 'Stress API tests' }),
      );

      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]).toMatchObject({
        company: 'Acme',
        role: 'Senior SDET',
        resumeText: RESUME,
        greeting: 'Dear Jane Doe,',
        tone: 'warm',
        length: 'short',
        steer: 'Stress API tests',
      });
      expect(model.requests[0]?.postingText).toContain('Playwright and TypeScript suites');
      expect(result).toEqual({
        coverLetter: {
          text: LETTER,
          length: 'short',
          tone: 'warm',
          steer: 'Stress API tests',
          draftedAt: T0.toISOString(),
          savedAt: null,
          resumeChanged: false,
        },
        hasPostingText: true,
      });
      expect(letterOf(await read(me.cookie, me.id))).toEqual(result);
      expect(links.read).toBe(1);

      // Drafting again uses the stored posting (no link read), and the defaults.
      letterOf(await draft(me.cookie, me.id));
      expect(links.read).toBe(1);
      expect(model.requests[1]).toMatchObject({
        tone: 'professional',
        length: 'standard',
        steer: '',
        postingText: model.requests[0]?.postingText,
      });
    });

    it('greets the hiring manager when the contact is not a name', async () => {
      const me = await owner({ contact: 'jobs@acme.example' });
      letterOf(await draft(me.cookie, me.id));
      expect(model.requests[0]?.greeting).toBe('Dear Hiring Manager,');
    });

    it('uses the posting stored by Tailor my resume, with no link read', async () => {
      const me = await owner({ jobLink: null });
      await t.db.query(
        `insert into application_tailorings (application_id, user_id, posting_text)
       values ($1, $2, $3)`,
        [me.id, me.user.id, POSTING_TEXT],
      );
      expect(letterOf(await read(me.cookie, me.id)).hasPostingText).toBe(true);

      letterOf(await draft(me.cookie, me.id));

      expect(model.requests[0]?.postingText).toBe(POSTING_TEXT);
      expect(links.read).toBe(0);
    });

    it('asks for the posting when the link cannot be read, then drafts from the paste', async () => {
      const linkedIn = await owner({ jobLink: 'https://www.linkedin.com/jobs/view/123' });
      const unreadable = await draft(linkedIn.cookie, linkedIn.id);
      expect(unreadable.statusCode).toBe(422);
      expect(unreadable.json()).toMatchObject({ error: 'posting_unreadable' });

      const noLink = await owner({ jobLink: null });
      expect((await draft(noLink.cookie, noLink.id)).json()).toMatchObject({
        error: 'no_job_link',
      });
      expect(model.requests).toHaveLength(0);

      const pasted = letterOf(await draft(noLink.cookie, noLink.id, { postingText: POSTING_TEXT }));
      expect(model.requests[0]?.postingText).toBe(POSTING_TEXT.trim());
      expect(pasted.hasPostingText).toBe(true);
      expect((await draft(noLink.cookie, noLink.id, { postingText: 'SDET' })).statusCode).toBe(400);
      expect((await draft(noLink.cookie, noLink.id, { tone: 'sarcastic' })).statusCode).toBe(400);
    });

    it('asks once more when the letter runs long, then cuts it to the limit', async () => {
      const me = await owner();
      const long = `${'Word '.repeat(460).trim()}.`;
      model.answers = [{ letter: long }, { letter: LETTER }];
      expect(letterOf(await draft(me.cookie, me.id)).coverLetter?.text).toBe(LETTER);
      expect(model.requests[1]?.tooLong).toBe('it was 460 words (aim for about 300)');

      // Still too long the second time: kept, cut at 5,000 characters.
      model.requests = [];
      const huge = `${'A sentence of words. '.repeat(300).trim()}`;
      model.answers = [{ letter: huge }];
      const text = letterOf(await draft(me.cookie, me.id)).coverLetter?.text ?? '';
      expect(model.requests).toHaveLength(2);
      expect(text.length).toBeLessThanOrEqual(5000);
      expect(text.endsWith('words.')).toBe(true);
    });

    it('answers 502 when the draft does not finish, 503 without a key, 409 without a resume', async () => {
      const me = await owner();
      model.answers = [null];
      expect((await draft(me.cookie, me.id)).json()).toMatchObject({ error: 'draft_failed' });
      model.answers = [{ letter: '   ' }];
      expect((await draft(me.cookie, me.id)).json()).toMatchObject({ error: 'draft_failed' });
      model.answers = ['unavailable'];
      expect((await draft(me.cookie, me.id)).statusCode).toBe(503);
      expect(letterOf(await read(me.cookie, me.id)).coverLetter).toBeNull();

      const noResume = await owner({ resume: false });
      expect((await draft(noResume.cookie, noResume.id)).json()).toMatchObject({
        error: 'no_resume',
      });
    });

    it('answers a Claude limit with 503 and keeps the letter as it was', async () => {
      const me = await owner();
      letterOf(await draft(me.cookie, me.id));
      model.requests = [];

      model.answers = [new ClaudeLimitError('rate_limited', 30)];
      const busy = await draft(me.cookie, me.id, { tone: 'warm' });
      expect(busy.statusCode).toBe(503);
      expect(busy.headers['retry-after']).toBe('30');
      expect(busy.json()).toMatchObject({ error: 'claude_busy' });

      model.answers = [new ClaudeLimitError('spend_limit', null)];
      const spent = await draft(me.cookie, me.id);
      expect(spent.statusCode).toBe(503);
      expect(spent.headers['retry-after']).toBeUndefined();
      expect(spent.json()).toMatchObject({ error: 'claude_limit_reached' });

      expect(letterOf(await read(me.cookie, me.id)).coverLetter).toMatchObject({
        text: LETTER,
        tone: 'professional',
      });
    });

    it('allows 20 drafts a day', async () => {
      const me = await owner();
      for (let index = 0; index < COVER_LETTER_RULE.limit; index += 1)
        expect((await draft(me.cookie, me.id)).statusCode).toBe(200);
      const limited = await draft(me.cookie, me.id);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(COVER_LETTER_RULE.limit).toBe(20);
    });

    it('saves the letter as edited, flags a replaced resume, and removes it', async () => {
      const me = await owner();
      letterOf(await draft(me.cookie, me.id, { tone: 'direct' }));
      t.clock.set(new Date(T0.getTime() + 60_000));
      const edited = `${LETTER}\n\nP.S. Available to start in May.`;

      const saved = letterOf(await save(me.cookie, me.id, `  ${edited}  `));

      expect(saved.coverLetter).toMatchObject({
        text: edited,
        tone: 'direct',
        draftedAt: T0.toISOString(),
        savedAt: new Date(T0.getTime() + 60_000).toISOString(),
        resumeChanged: false,
      });

      await send('PUT', '/api/resume', me.cookie, { kind: 'text', text: `${RESUME}\n- New line.` });
      expect(letterOf(await read(me.cookie, me.id)).coverLetter?.resumeChanged).toBe(true);

      // Drafting again replaces it as an unsaved draft.
      expect(letterOf(await draft(me.cookie, me.id)).coverLetter).toMatchObject({
        text: LETTER,
        savedAt: null,
        resumeChanged: false,
      });

      expect(letterOf(await remove(me.cookie, me.id))).toEqual({
        coverLetter: null,
        hasPostingText: false,
      });
      expect((await save(me.cookie, me.id, '')).statusCode).toBe(400);
    });

    it('saves a letter written by hand, with no draft first', async () => {
      const me = await owner();
      const saved = letterOf(await save(me.cookie, me.id, 'Dear Acme,\n\nHello.'));
      expect(saved.coverLetter).toMatchObject({
        text: 'Dear Acme,\n\nHello.',
        length: 'standard',
        tone: 'professional',
        steer: '',
        resumeChanged: false,
      });
      expect(saved.coverLetter?.savedAt).not.toBeNull();
      expect(model.requests).toHaveLength(0);
    });

    it('leaves the application itself unchanged', async () => {
      const me = await owner();
      const before = (await send('GET', `/api/applications/${me.id}`, me.cookie)).json<object>();
      await draft(me.cookie, me.id);
      await save(me.cookie, me.id, LETTER);
      const after = (await send('GET', `/api/applications/${me.id}`, me.cookie)).json<object>();
      expect(after).toEqual(before);
    });

    it('is in the data export, and goes with the application', async () => {
      const me = await owner();
      await draft(me.cookie, me.id, { tone: 'enthusiastic' });
      const exported = DataExportSchema.parse(
        (await send('GET', '/api/me/export', me.cookie)).json(),
      );
      expect(exported.applicationCoverLetters).toHaveLength(1);
      expect(exported.applicationCoverLetters[0]).toMatchObject({
        applicationId: me.id,
        coverLetter: { coverLetter: { text: LETTER, tone: 'enthusiastic' } },
      });
      expect(exported.applicationCoverLetters[0]?.postingText).toContain('Playwright');

      await send('DELETE', `/api/applications/${me.id}`, me.cookie);
      const left = await t.db.query(
        'select 1 from application_cover_letters where application_id = $1',
        [me.id],
      );
      expect(left.rowCount).toBe(0);
    });

    it("gives another user 404 for someone else's application, and changes nothing", async () => {
      const me = await owner();
      await draft(me.cookie, me.id);
      await save(me.cookie, me.id, LETTER);
      const other = await owner();
      for (const id of [me.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
        for (const response of [
          await read(other.cookie, id),
          await draft(other.cookie, id),
          await save(other.cookie, id, 'Mine now'),
          await remove(other.cookie, id),
        ]) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: 'not_found' });
        }
      }
      expect(letterOf(await read(me.cookie, me.id)).coverLetter?.text).toBe(LETTER);
      expect(model.requests).toHaveLength(1);
    });

    it('is not available (404) to a user who is not on the list', async () => {
      const stranger = await t.login();
      await send('PUT', '/api/resume', stranger.cookie, { kind: 'text', text: RESUME });
      const application = (
        await send('POST', '/api/applications', stranger.cookie, {
          company: 'Acme',
          role: 'SDET',
          jobLink: POSTING_LINK,
        })
      ).json<{ id: string }>();
      for (const response of [
        await read(stranger.cookie, application.id),
        await draft(stranger.cookie, application.id),
        await save(stranger.cookie, application.id, LETTER),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: 'not_available' });
      }
      expect(model.requests).toHaveLength(0);
    });
  },
);
