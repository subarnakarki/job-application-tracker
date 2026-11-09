import { readFileSync } from 'node:fs';
import {
  ApplyQueueSchema,
  SEARCH_SOURCES,
  EMPTY_MORE_ANSWERS,
  DEFAULT_QUERY,
  JobHitSchema,
  JobSearchRunDetailSchema,
  JobSearchSetupSchema,
  type JobHit,
  type JobSearchProfile,
  type ModelDraft,
  type SearchSource,
  type TailorAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSearchClaude, TailorRequest } from '../jobsearch/claude';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { CHECK_RULE, MANUAL_RUN_RULE, TAILOR_RULE } from './jobSearch';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdef';
const HOUR = 60 * 60 * 1000;

/** A real Greenhouse answer (trimmed), re-dated and re-titled for each job the search "finds". */
const GREENHOUSE = JSON.parse(
  readFileSync(new URL('../jobsearch/fixtures/greenhouse-job.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const greenhouseJob = (
  title: string,
  postedHoursAgo: number,
  content = 'Own the roadmap. '.repeat(20),
  location = 'Remote, United States',
) =>
  JSON.stringify({
    ...GREENHOUSE,
    title,
    content,
    location: { name: location },
    first_published: new Date(T0.getTime() - postedHoursAgo * HOUR).toISOString(),
  });
const apiUrl = (id: number) =>
  `https://boards-api.greenhouse.io/v1/boards/acme/jobs/${String(id)}?questions=true&pay_transparency=true`;
const jobLink = (id: number) => `https://job-boards.greenhouse.io/acme/jobs/${String(id)}`;

const ICIMS = 'https://careers-initech.icims.com/jobs/4321/senior-product-manager/job';

const PAGES: Record<string, string> = {
  [apiUrl(101)]: greenhouseJob('Senior Product Manager', 3),
  [apiUrl(102)]: greenhouseJob(
    'Engineering Manager',
    5,
    'You partner with the product manager. '.repeat(10),
  ),
  [apiUrl(103)]: greenhouseJob('Product Manager, Growth', 72),
  [apiUrl(104)]: greenhouseJob('Product Manager Intern', 2),
  [apiUrl(105)]: greenhouseJob('Product Manager, EMEA', 2, undefined, 'London, UK'),
};
/** Pages the board now answers 404 for (taken down), and pages that time out, per test. */
const GONE = new Set<string>();
const TIMING_OUT = new Set<string>();
const fetchPage: PageFetcher = (url) => {
  if (GONE.has(url)) return Promise.reject(new FetchError('http_status', '404'));
  if (TIMING_OUT.has(url)) return Promise.reject(new FetchError('timeout', 'slow board'));
  const text = PAGES[url];
  return text === undefined
    ? Promise.reject(new FetchError('network', 'tests never reach the network'))
    : Promise.resolve({ url, contentType: 'application/json', text });
};

/** The model's side, chosen per test: what the search finds and how drafts answer. */
interface StubClaude extends JobSearchClaude {
  links: string[];
  /** Extra search results (title and age) for links, besides the iCIMS one. */
  results: Record<string, { title: string; pageAge: string | null }>;
  searches: { query: string; sources: SearchSource[] }[];
  drafts: number;
  draftsFail: boolean;
  /** The posting keywords every draft returns. */
  keywords: string[];
  /** What "Tailor my resume" answers, and what it was asked. */
  tailorAnswer: TailorAnswer | null;
  tailorRequests: TailorRequest[];
}
const claude: StubClaude = {
  links: [101, 102, 103, 104].map(jobLink),
  results: {},
  searches: [],
  drafts: 0,
  draftsFail: false,
  keywords: [],
  tailorAnswer: null,
  tailorRequests: [],
  tailor(request: TailorRequest) {
    claude.tailorRequests.push(request);
    return Promise.resolve(claude.tailorAnswer);
  },
  search(query: string, sources: SearchSource[]) {
    claude.searches.push({ query, sources });
    return Promise.resolve({
      links: [...claude.links, 'https://job-boards.greenhouse.io/acme', 'https://evil.example/x'],
      results: {
        ...claude.results,
        // An iCIMS page the server cannot read: the job comes from this search result.
        [ICIMS]: {
          title: 'Senior Product Manager - Remote | Initech Careers',
          pageAge: '5 hours ago',
        },
      },
      searches: 2,
    });
  },
  draft(request: { questions: { label: string }[] }): Promise<ModelDraft | null> {
    claude.drafts += 1;
    if (claude.draftsFail) return Promise.resolve(null);
    return Promise.resolve({
      // A country the trimmed option list does not have, so that question needs the candidate.
      answers: request.questions.map((question) => ({
        question: question.label,
        answer: /country/i.test(question.label) ? 'United States' : 'No',
        needsCandidate: false,
      })),
      coverLetter: 'Dear Acme team, ...',
      whyInterested: 'The roadmap work.',
      keywords: claude.keywords.map((term) => ({ term, group: 'hard_skill' as const })),
    });
  },
};

const PROFILE: JobSearchProfile = {
  fullName: 'Pat Example',
  email: 'pat@example.com',
  phone: '+1 555 010 0199',
  city: 'Boston',
  state: 'MA',
  workAuthorization: 'US citizen',
  needsSponsorship: false,
  salaryMin: 150000,
  salaryMax: null,
  linkedin: 'https://www.linkedin.com/in/pat',
  portfolio: '',
  website: '',
  workModes: ['Remote', 'Hybrid'],
  usOnly: true,
  sites: [...SEARCH_SOURCES],
  queries: [DEFAULT_QUERY],
  includeTitles: ['product manager'],
  skipTitles: ['intern'],
  timeframeDays: 1,
  cadence: 'daily',
  runHour: 8,
  runWeekday: 1,
  scheduleOn: true,
  willingToRelocate: 'No',
  startDate: 'Two weeks after an offer',
  howHeard: 'Company careers page',
  over18: true,
  gender: 'Decline to self-identify',
  hispanicLatino: 'decline',
  raceEthnicity: 'Decline to self-identify',
  veteranStatus: 'decline',
  disabilityStatus: 'decline',
  eeoAnswer: 'Decline to self-identify',
  more: EMPTY_MORE_ANSWERS,
};

function parsed<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }) {
  return (response: LightMyRequestResponse): T => {
    const result = schema.safeParse(response.json());
    if (!result.success || result.data === undefined)
      throw new Error(
        `Response broke the contract (${String(response.statusCode)}): ${response.body}`,
      );
    return result.data;
  };
}
const runOf = parsed(JobSearchRunDetailSchema);
const hitOf = parsed(JobHitSchema);
const queueOf = parsed(ApplyQueueSchema);

describe.skipIf(!TEST_DATABASE_URL)('job search API (real app, real database)', () => {
  let t: TestApp;
  const env: Record<string, string> = {
    JOB_SEARCH_USER_IDS: '',
    JOB_SEARCH_CRON_SECRET: CRON_SECRET,
  };

  beforeAll(async () => {
    t = await createTestApp({ env, jobSearchClaude: claude, fetchPage });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    claude.links = [101, 102, 103, 104].map(jobLink);
    claude.results = {};
    claude.searches = [];
    claude.drafts = 0;
    claude.draftsFail = false;
    claude.keywords = [];
    claude.tailorAnswer = null;
    claude.tailorRequests = [];
    GONE.clear();
    TIMING_OUT.clear();
    t.clock.set(T0);
    await t.db.query("delete from rate_limits where key like 'job-search%'");
  });

  const send = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie },
      ...(payload ? { payload } : method === 'GET' ? {} : { payload: {} }),
    });

  /** A signed-in user the job search is open to, set up, with a resume. */
  async function member(options: { setUp?: boolean; resume?: boolean } = {}) {
    const login = await t.login({ timeZone: 'America/New_York' });
    env['JOB_SEARCH_USER_IDS'] = [env['JOB_SEARCH_USER_IDS'], login.user.id]
      .filter(Boolean)
      .join(',');
    if (options.setUp !== false)
      expect((await send('PUT', '/api/job-search/profile', login.cookie, PROFILE)).statusCode).toBe(
        200,
      );
    if (options.resume !== false)
      await send('PUT', '/api/resume', login.cookie, {
        kind: 'text',
        text: 'Pat Example. Senior product manager, eight years of roadmaps. '.repeat(5),
      });
    return login;
  }
  const run = (cookie: string) => send('POST', '/api/job-search/runs', cookie);
  const byRole = (hits: JobHit[], role: string) => {
    const hit = hits.find((entry) => entry.role === role);
    if (!hit) throw new Error(`no hit for ${role}`);
    return hit;
  };

  describe('who may use it', () => {
    it('is closed (404) to a user not on the list, and says so on the setup', async () => {
      const { cookie } = await t.login();
      expect(
        parsed(JobSearchSetupSchema)(await send('GET', '/api/job-search/profile', cookie)),
      ).toEqual({
        available: false,
        profile: null,
        confirmedAt: null,
        hasResume: false,
      });
      for (const [method, url, body] of [
        ['PUT', '/api/job-search/profile', PROFILE],
        ['POST', '/api/job-search/runs', undefined],
        ['GET', '/api/job-search/queue', undefined],
      ] as const) {
        const response = await send(method, url, cookie, body);
        expect(response.statusCode, url).toBe(404);
        expect(response.json()).toMatchObject({ error: 'not_available' });
      }
    });

    it('saves the setup once confirmed, and needs it and a resume before a run', async () => {
      const notSetUp = await member({ setUp: false, resume: false });
      expect((await run(notSetUp.cookie)).json()).toMatchObject({ error: 'not_set_up' });

      const noResume = await member({ resume: false });
      const setup = parsed(JobSearchSetupSchema)(
        await send('GET', '/api/job-search/profile', noResume.cookie),
      );
      expect(setup).toMatchObject({ available: true, profile: PROFILE, hasResume: false });
      expect((await run(noResume.cookie)).json()).toMatchObject({ error: 'no_resume' });
    });

    it('refuses a profile that is not valid', async () => {
      const { cookie } = await member();
      const response = await send('PUT', '/api/job-search/profile', cookie, {
        ...PROFILE,
        linkedin: 'javascript:alert(1)',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('a run', () => {
    it('searches the saved query, reads each job once, sorts them and drafts the targets', async () => {
      const { cookie } = await member();

      const response = await run(cookie);

      expect(response.statusCode).toBe(201);
      const { run: summary, hits } = runOf(response);
      // The written search's own site: gives way to the chosen sites (all of them here).
      expect(claude.searches).toEqual([
        { query: '"product manager"', sources: [...SEARCH_SOURCES] },
      ]);
      expect(summary).toMatchObject({
        trigger: 'manual',
        status: 'done',
        searches: 2,
        counts: { found: 4, target: 1, keywordOnly: 1, skipped: 2, needsYou: 1, notDrafted: 0 },
      });
      expect(hits.map((hit) => [hit.role, hit.kind, hit.state])).toEqual([
        ['Senior Product Manager', 'target', 'needs_you'],
        ['Engineering Manager', 'keyword_only', 'new'],
        ['Product Manager Intern', 'skipped', 'skipped'],
        ['Product Manager, Growth', 'skipped', 'skipped'],
      ]);
      expect(byRole(hits, 'Product Manager, Growth').reason).toBe('Posted more than 1 day ago');
      // Progress ends at done, with every step's counts.
      expect(summary.progress).toEqual({
        step: 'done',
        queriesDone: 1,
        queriesTotal: 1,
        boardsDone: 1,
        boardsTotal: 1,
        jobsRead: 4,
        jobsTotal: 4,
        drafted: 1,
        draftsTotal: 1,
      });
      expect(claude.drafts).toBe(1);

      const target = byRole(hits, 'Senior Product Manager');
      expect(target).toMatchObject({
        company: 'GitLab',
        jobLink: jobLink(101),
        applyLink: jobLink(101),
        workMode: 'Remote',
      });
      const answers = new Map(target.draft?.answers.map((answer) => [answer.question, answer]));
      expect(answers.get('First Name')).toMatchObject({ answer: 'Pat', source: 'profile' });
      expect(
        [...answers.values()].find((answer) => /sponsorship/.test(answer.question)),
      ).toMatchObject({ answer: 'No', option: 'No', source: 'profile' });
      expect(answers.get('Have you previously worked at or consulted for GitLab?')).toMatchObject({
        option: 'No',
        source: 'draft',
      });
      // Not one of the (trimmed) options: the candidate answers it.
      expect(answers.get('What is your current country of residence?')?.source).toBe('needs_you');
      expect(answers.get('Gender')).toMatchObject({ answer: 'Decline to self-identify' });
      expect(target.draft?.coverLetter).toBe('Dear Acme team, ...');
    });

    it('skips jobs outside the US, and keeps an unreadable page from its search result', async () => {
      const { cookie } = await member();
      // No site: in the query, so every board counts.
      await send('PUT', '/api/job-search/profile', cookie, {
        ...PROFILE,
        queries: ['"product manager"'],
      });
      claude.links = [jobLink(105), ICIMS];

      const { hits } = runOf(await run(cookie));

      expect(byRole(hits, 'Product Manager, EMEA')).toMatchObject({
        kind: 'skipped',
        reason: 'Outside the United States (London, UK)',
      });
      // iCIMS needs an account, and its page could not be read: listed to finish by hand.
      expect(byRole(hits, 'Senior Product Manager')).toMatchObject({
        source: 'icims',
        company: 'Initech',
        kind: 'finish_yourself',
        reason: 'iCIMS needs an account at each company (from the search result only)',
        jobLink: ICIMS,
      });
    });

    it('drops a job its board says is gone, even when the search still lists it', async () => {
      const { cookie } = await member();
      // 199 has no page: the Greenhouse API answers 404, so the job is closed.
      const closed = jobLink(199);
      claude.links = [closed];
      claude.results = {
        [closed]: { title: 'Senior Product Manager | Acme', pageAge: '1 day ago' },
      };

      const { hits } = runOf(await run(cookie));

      expect(hits).toEqual([]);
    });

    it("finds new jobs on the boards of companies it has found, from the board's own list", async () => {
      const { cookie } = await member();
      claude.links = [jobLink(103)]; // an old posting: it only tells the search about acme
      const list = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs';
      PAGES[list] = JSON.stringify({
        jobs: [
          {
            id: 301,
            title: 'Product Manager, Payments',
            first_published: new Date(T0.getTime() - 2 * HOUR).toISOString(),
            absolute_url: jobLink(301),
          },
          {
            id: 302,
            title: 'Product Manager, Old',
            first_published: '2026-01-01T00:00:00Z',
            absolute_url: jobLink(302),
          },
        ],
      });
      PAGES[apiUrl(301)] = greenhouseJob('Product Manager, Payments', 2);
      try {
        const { hits } = runOf(await run(cookie));
        expect(byRole(hits, 'Product Manager, Payments')).toMatchObject({
          kind: 'target',
          jobLink: jobLink(301),
          state: 'needs_you',
        });
        // The old one on the same list was never even read.
        expect(hits.some((hit) => hit.role === 'Product Manager, Old')).toBe(false);
      } finally {
        delete PAGES[list];
        delete PAGES[apiUrl(301)];
      }
    });

    it('keeps jobs outside the US when United States only is off', async () => {
      const { cookie } = await member();
      await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, usOnly: false });
      claude.links = [jobLink(105)];
      const { hits } = runOf(await run(cookie));
      expect(byRole(hits, 'Product Manager, EMEA').kind).toBe('target');
    });

    it('searches only the ticked sites, with searches made from the titles', async () => {
      const { cookie } = await member();
      await send('PUT', '/api/job-search/profile', cookie, {
        ...PROFILE,
        queries: [],
        includeTitles: ['product manager', 'QA lead'],
        sites: ['greenhouse', 'ashby'],
      });
      claude.links = [jobLink(101)];
      await run(cookie);
      expect(claude.searches).toEqual([
        {
          query:
            'site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:jobs.ashbyhq.com "product manager"',
          sources: ['greenhouse', 'ashby'],
        },
        {
          query:
            'site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:jobs.ashbyhq.com "QA lead"',
          sources: ['greenhouse', 'ashby'],
        },
      ]);
    });

    it('never shows a job twice, and refuses a second run while one is going', async () => {
      const { cookie, user } = await member();
      expect((await run(cookie)).statusCode).toBe(201);
      const again = runOf(await run(cookie));
      expect(again.hits).toEqual([]);

      await t.db.query(
        "insert into job_search_runs (user_id, trigger, local_day, started_at) values ($1, 'manual', '2026-11-05', $2)",
        [user.id, t.clock.now()],
      );
      const busy = await run(cookie);
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ error: 'run_in_progress' });
    });

    it('skips a job already applied to, matched however the names are written', async () => {
      const { cookie } = await member();
      const created = await send('POST', '/api/applications', cookie, {
        company: 'Gitlab, Inc.',
        role: 'Sr. Product Manager',
        status: 'Interviewing',
      });
      const { hits } = runOf(await run(cookie));
      expect(byRole(hits, 'Senior Product Manager')).toMatchObject({
        kind: 'skipped',
        reason: 'Already applied · Interviewing',
        tracked: { applicationId: created.json<{ id: string }>().id, status: 'Interviewing' },
      });
    });

    it('labels a found job applied to later, when the lists are read', async () => {
      const { cookie } = await member();
      const { hits } = runOf(await run(cookie));
      const target = byRole(hits, 'Senior Product Manager');
      expect(target.tracked).toBeNull();

      // Applied outside the job search, by the posting's link.
      await send('POST', '/api/applications', cookie, {
        company: 'Somewhere',
        role: 'Something',
        status: 'Applied',
        jobLink: `${jobLink(101)}?gh_src=linkedin`,
      });
      const queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.needsYou.find((hit) => hit.id === target.id)?.tracked?.status).toBe('Applied');
    });

    it('allows ten runs by hand a day', async () => {
      const { cookie } = await member();
      claude.links = [];
      for (let index = 0; index < MANUAL_RUN_RULE.limit; index += 1)
        expect((await run(cookie)).statusCode).toBe(201);
      expect((await run(cookie)).statusCode).toBe(429);
    });

    it('keeps a job undrafted when its draft fails, for a later try', async () => {
      const { cookie } = await member();
      claude.draftsFail = true;
      const { run: summary, hits } = runOf(await run(cookie));
      expect(summary.counts.notDrafted).toBe(1);
      expect(byRole(hits, 'Senior Product Manager')).toMatchObject({
        state: 'new',
        draftError: 'The draft did not finish',
      });
    });
  });

  describe('the apply queue', () => {
    async function withRun() {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      return { ...login, hits };
    }

    it('groups waiting jobs, and finishing the answers makes a job ready', async () => {
      const { cookie, hits } = await withRun();
      let queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.needsYou.map((hit) => hit.role)).toEqual(['Senior Product Manager']);
      expect(queue.keywordOnly.map((hit) => hit.role)).toEqual(['Engineering Manager']);
      expect(queue.ready).toEqual([]);

      const target = byRole(hits, 'Senior Product Manager');
      const edited = await send('PUT', `/api/job-search/hits/${target.id}/draft`, cookie, {
        answers: [
          { question: 'What is your current country of residence?', answer: 'United States' },
        ],
        coverLetter: 'Edited letter',
      });
      expect(hitOf(edited)).toMatchObject({
        state: 'ready',
        draft: { coverLetter: 'Edited letter' },
      });
      queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.ready.map((hit) => hit.id)).toEqual([target.id]);
    });

    it("scores each drafted job's fit against the current resume, best fit first", async () => {
      claude.keywords = ['roadmaps', 'product manager', 'SQL', 'Figma', 'Jira'];
      const { cookie, hits } = await withRun();
      const target = byRole(hits, 'Senior Product Manager');
      expect(target.fit).toEqual({
        percent: 40,
        found: ['roadmaps', 'product manager'],
        missing: ['SQL', 'Figma', 'Jira'],
      });
      expect(target.draft?.keywords).toHaveLength(5);

      // A new resume rescores every job on the next read, with no new draft.
      await send('PUT', '/api/resume', cookie, {
        kind: 'text',
        text: 'Pat Example. Senior product manager: roadmaps, SQL, Figma and Jira. '.repeat(5),
      });
      const queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.needsYou[0]?.fit).toMatchObject({ percent: 100, missing: [] });
      expect(claude.drafts).toBe(1);
    });

    it('has no fit for a job drafted before keywords were kept', async () => {
      const { cookie, hits } = await withRun();
      const target = byRole(hits, 'Senior Product Manager');
      await t.db.query("update job_search_hits set draft = draft - 'keywords' where id = $1", [
        target.id,
      ]);
      const queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.needsYou[0]).toMatchObject({ id: target.id, fit: null });
    });

    it('lists older matches, and adds one to the queue', async () => {
      const { cookie, hits } = await withRun();
      // "Product Manager, Growth" (3 days old) was skipped only for its age under the 1-day
      // window; widening the window makes it an older match. The intern stays out (its title).
      let queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.olderMatches).toEqual([]);
      await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, timeframeDays: 7 });
      queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.olderMatches.map((hit) => hit.role)).toEqual(['Product Manager, Growth']);

      const older = byRole(hits, 'Product Manager, Growth');
      const added = hitOf(await send('POST', `/api/job-search/hits/${older.id}/queue`, cookie));
      expect(added).toMatchObject({ kind: 'target', state: 'needs_you' });
      queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.olderMatches).toEqual([]);
      expect(queue.needsYou.map((hit) => hit.role)).toContain('Product Manager, Growth');

      // The intern cannot be added this way.
      const intern = byRole(hits, 'Product Manager Intern');
      expect(
        hitOf(await send('POST', `/api/job-search/hits/${intern.id}/queue`, cookie)).state,
      ).toBe('skipped');
    });

    it('marks a job applied once, creating the application in the tracker', async () => {
      const { cookie, hits } = await withRun();
      const target = byRole(hits, 'Senior Product Manager');

      const applied = hitOf(
        await send('POST', `/api/job-search/hits/${target.id}/applied`, cookie),
      );
      expect(applied.state).toBe('applied');
      expect(applied.applicationId).not.toBeNull();
      const again = hitOf(await send('POST', `/api/job-search/hits/${target.id}/applied`, cookie));
      expect(again.applicationId).toBe(applied.applicationId);

      const application = await send(
        'GET',
        `/api/applications/${applied.applicationId ?? ''}`,
        cookie,
      );
      expect(application.json()).toMatchObject({
        company: 'GitLab',
        role: 'Senior Product Manager',
        status: 'Applied',
        source: 'Company site',
        dateApplied: '2026-11-05',
        jobLink: jobLink(101),
      });
      const list = await send('GET', '/api/applications', cookie);
      expect(list.json<{ total: number }>().total).toBe(1);
    });

    it('marks a job blocked with a reason, or skipped', async () => {
      const { cookie, hits } = await withRun();
      const target = byRole(hits, 'Senior Product Manager');
      expect(
        hitOf(
          await send('POST', `/api/job-search/hits/${target.id}/blocked`, cookie, {
            reason: 'Needs an account',
          }),
        ),
      ).toMatchObject({ state: 'blocked', blockReason: 'Needs an account' });
      const other = byRole(hits, 'Engineering Manager');
      expect(hitOf(await send('POST', `/api/job-search/hits/${other.id}/skip`, cookie)).state).toBe(
        'skipped',
      );
      const blankReason = await send('POST', `/api/job-search/hits/${target.id}/blocked`, cookie, {
        reason: ' ',
      });
      expect(blankReason.statusCode).toBe(400);
    });

    it('moves a keyword-only job into the queue and drafts it', async () => {
      const { cookie, hits } = await withRun();
      const other = byRole(hits, 'Engineering Manager');
      const moved = hitOf(await send('POST', `/api/job-search/hits/${other.id}/queue`, cookie));
      expect(moved).toMatchObject({ kind: 'target', state: 'needs_you' });
      expect(claude.drafts).toBe(2);
    });
  });

  describe('the still-open check', () => {
    const check = (cookie: string) => send('POST', '/api/job-search/queue/check', cookie);

    it('closes a job its board says is gone, and leaves one it could not read', async () => {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      const target = byRole(hits, 'Senior Product Manager');
      const keywordOnly = byRole(hits, 'Engineering Manager');
      GONE.add(apiUrl(101));
      TIMING_OUT.add(apiUrl(102));
      t.clock.set(new Date(T0.getTime() + HOUR));

      const result = await check(login.cookie);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ checked: 1, closed: 1, unknown: 1 });

      const queue = queueOf(await send('GET', '/api/job-search/queue', login.cookie));
      expect(queue.needsYou).toEqual([]);
      expect(queue.keywordOnly.map((hit) => hit.id)).toEqual([keywordOnly.id]);
      expect(queue.keywordOnly[0]?.checkedAt).toBeNull();
      expect(queue.checks).toEqual({
        lastCheckedAt: new Date(T0.getTime() + HOUR).toISOString(),
        closedThisWeek: 1,
      });
      const detail = runOf(
        await send('GET', `/api/job-search/runs/${hits[0]?.runId ?? ''}`, login.cookie),
      );
      expect(byRole(detail.hits, 'Senior Product Manager')).toMatchObject({
        id: target.id,
        state: 'closed',
        checkedAt: new Date(T0.getTime() + HOUR).toISOString(),
      });

      // Once the board answers again, the job it could not read is checked and stays open.
      TIMING_OUT.clear();
      expect((await check(login.cookie)).json()).toEqual({ checked: 1, closed: 0, unknown: 0 });
      const after = queueOf(await send('GET', '/api/job-search/queue', login.cookie));
      expect(after.keywordOnly[0]).toMatchObject({ state: 'new' });
      expect(after.checks.lastCheckedAt).toBe(new Date(T0.getTime() + HOUR).toISOString());
    });

    it('never closes a job that is already applied to', async () => {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      const target = byRole(hits, 'Senior Product Manager');
      await send('POST', `/api/job-search/hits/${target.id}/applied`, login.cookie);
      GONE.add(apiUrl(101));
      await check(login.cookie);
      expect(
        hitOf(await send('POST', `/api/job-search/hits/${target.id}/closed`, login.cookie)).state,
      ).toBe('applied');
    });

    it(`allows ${String(CHECK_RULE.limit)} checks by hand a day`, async () => {
      const { cookie } = await member();
      for (let index = 0; index < CHECK_RULE.limit; index += 1)
        expect((await check(cookie)).statusCode).toBe(200);
      expect((await check(cookie)).statusCode).toBe(429);
    });

    it('marks a job closed by hand', async () => {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      const target = byRole(hits, 'Senior Product Manager');
      const closed = hitOf(
        await send('POST', `/api/job-search/hits/${target.id}/closed`, login.cookie),
      );
      expect(closed.state).toBe('closed');
      const queue = queueOf(await send('GET', '/api/job-search/queue', login.cookie));
      expect(queue.needsYou).toEqual([]);
    });
  });

  describe('tailor my resume', () => {
    const LINE = 'Senior product manager, eight years of roadmaps.';
    async function drafted() {
      claude.keywords = ['roadmaps', 'product manager', 'SQL', 'Figma', 'Jira'];
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      return { ...login, target: byRole(hits, 'Senior Product Manager') };
    }
    const tailor = (cookie: string, id: string) =>
      send('POST', `/api/job-search/hits/${id}/tailor`, cookie);

    it('stores the checked edits: invented lines dropped, invented facts flagged', async () => {
      const { cookie, target } = await drafted();
      claude.tailorAnswer = {
        edits: [
          {
            original: LINE,
            suggested:
              'Senior product manager, eight years of roadmaps planned in Jira with SQL at Google.',
            keywordsAdded: ['Jira', 'SQL', 'Kubernetes'],
            why: 'Roadmap work.',
          },
          {
            original: 'Led a Figma design system for 30 teams.',
            suggested: 'Led a Figma design system for 30 teams.',
            keywordsAdded: ['Figma'],
            why: 'Invented.',
          },
        ],
        notCovered: [{ keyword: 'Figma', why: 'No design tools in the resume.' }],
      };

      const hit = hitOf(await tailor(cookie, target.id));

      expect(claude.tailorRequests[0]).toMatchObject({
        company: target.company,
        role: 'Senior Product Manager',
        missing: ['SQL', 'Figma', 'Jira'],
      });
      expect(hit.tailoring).toMatchObject({
        edits: [
          {
            original: 'Senior product manager, eight years of roadmaps.',
            keywordsAdded: ['SQL', 'Jira'],
            // An employer the resume never mentions; the skills it adds are judged by their group.
            unverified: ['Google'],
          },
        ],
        notCovered: [{ keyword: 'Figma', why: 'No design tools in the resume.' }],
        model: 'claude-opus-5-5',
        createdAt: T0.toISOString(),
      });

      // Asking again replaces the suggestions.
      claude.tailorAnswer = { edits: [], notCovered: [] };
      expect(hitOf(await tailor(cookie, target.id)).tailoring?.edits).toEqual([]);
    });

    it('says why it cannot tailor: no keywords yet, a failed answer, the daily limit', async () => {
      const { cookie, target } = await drafted();
      expect((await tailor(cookie, target.id)).statusCode).toBe(502);

      claude.tailorAnswer = { edits: [], notCovered: [] };
      for (let index = 1; index < TAILOR_RULE.limit; index += 1)
        expect((await tailor(cookie, target.id)).statusCode).toBe(200);
      const limited = await tailor(cookie, target.id);
      expect(limited.statusCode).toBe(429);

      await t.db.query("update job_search_hits set draft = draft - 'keywords' where id = $1", [
        target.id,
      ]);
      await t.db.query("delete from rate_limits where key like 'job-search%'");
      const noKeywords = await tailor(cookie, target.id);
      expect(noKeywords.statusCode).toBe(409);
      expect(noKeywords.json()).toMatchObject({ error: 'no_keywords' });
    });
  });

  describe('the data export', () => {
    it('includes the setup, the runs and the jobs found', async () => {
      const { cookie } = await member();
      await run(cookie);
      const exported = await send('GET', '/api/me/export', cookie);
      expect(exported.statusCode).toBe(200);
      const { jobSearch } = exported.json<{
        jobSearch: { profile: unknown; runs: unknown[]; hits: unknown[] };
      }>();
      expect(jobSearch.profile).toEqual(PROFILE);
      expect(jobSearch.runs).toHaveLength(1);
      expect(jobSearch.hits).toHaveLength(4);
    });
  });

  describe('isolation between users', () => {
    it("answers 404 for someone else's run or job, and changes nothing", async () => {
      const owner = await member();
      const { run: theirRun, hits } = runOf(await run(owner.cookie));
      const target = byRole(hits, 'Senior Product Manager');
      const other = await member();

      const probes: [string, string, object | undefined][] = [
        ['GET', `/api/job-search/runs/{id}`, undefined],
        ['POST', `/api/job-search/hits/{id}/applied`, undefined],
        ['POST', `/api/job-search/hits/{id}/blocked`, { reason: 'x' }],
        ['POST', `/api/job-search/hits/{id}/skip`, undefined],
        ['POST', `/api/job-search/hits/{id}/closed`, undefined],
        ['POST', `/api/job-search/hits/{id}/tailor`, undefined],
        ['POST', `/api/job-search/hits/{id}/queue`, undefined],
        ['POST', `/api/job-search/hits/{id}/redraft`, undefined],
        ['PUT', `/api/job-search/hits/{id}/draft`, { answers: [], coverLetter: '' }],
      ];
      for (const [method, path, body] of probes) {
        const ownId = path.includes('/runs/') ? theirRun.id : target.id;
        for (const id of [ownId, MISSING_ID, 'not-a-uuid']) {
          const response = await send(
            method as 'GET' | 'POST' | 'PUT',
            path.replace('{id}', id),
            other.cookie,
            body,
          );
          expect(response.statusCode, `${method} ${path} ${id}`).toBe(404);
          expect(response.json()).toMatchObject({ error: 'not_found' });
        }
      }
      const unchanged = runOf(
        await send('GET', `/api/job-search/runs/${theirRun.id}`, owner.cookie),
      );
      expect(byRole(unchanged.hits, 'Senior Product Manager').state).toBe('needs_you');
    });
  });

  describe('the hourly schedule', () => {
    const cron = (secret?: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/cron/job-search',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-cron-secret': secret } : {}),
        },
        payload: '{}',
      });

    it('answers 404 without the right secret', async () => {
      expect((await cron()).statusCode).toBe(404);
      expect((await cron('wrong-secret-of-a-good-length-000000')).statusCode).toBe(404);
    });

    it('starts a due run once per local day, then only keeps drafting', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      const { cookie } = await member();
      // 13:30 UTC is 08:30 in New York: past the 8:00 run hour.
      t.clock.set(new Date('2026-11-05T13:30:00Z'));

      expect((await cron(CRON_SECRET)).json()).toEqual({ started: 1, drafted: 0 });
      expect((await cron(CRON_SECRET)).json()).toEqual({ started: 0, drafted: 0 });

      const runs = await send('GET', '/api/job-search/runs', cookie);
      expect(
        runs.json<{ items: { trigger: string }[] }>().items.map((item) => item.trigger),
      ).toEqual(['schedule']);
    });

    it('checks waiting jobs about once a day, closing the gone ones', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      const { cookie } = await member();
      const { hits } = runOf(await run(cookie));
      const target = byRole(hits, 'Senior Product Manager');
      GONE.add(apiUrl(101));
      t.clock.set(new Date('2026-11-05T12:30:00Z')); // 07:30 in New York: no run is due
      await cron(CRON_SECRET);
      const detail = runOf(await send('GET', `/api/job-search/runs/${target.runId}`, cookie));
      expect(byRole(detail.hits, 'Senior Product Manager').state).toBe('closed');
      expect(byRole(detail.hits, 'Engineering Manager').checkedAt).toBe('2026-11-05T12:30:00.000Z');
    });

    it('does not start a run before the run hour, or with the schedule off', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      const { cookie } = await member();
      t.clock.set(new Date('2026-11-05T12:30:00Z')); // 07:30 in New York
      expect((await cron(CRON_SECRET)).json()).toEqual({ started: 0, drafted: 0 });

      await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, scheduleOn: false });
      t.clock.set(new Date('2026-11-05T15:00:00Z'));
      expect((await cron(CRON_SECRET)).json()).toEqual({ started: 0, drafted: 0 });
    });
  });
});
