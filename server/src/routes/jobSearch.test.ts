import { readFileSync } from 'node:fs';
import {
  ApplicationCoverLetterSchema,
  ApplicationDetailSchema,
  ApplicationTailoringSchema,
  ApplyQueueSchema,
  SEARCH_SOURCES,
  EMPTY_MORE_ANSWERS,
  DEFAULT_QUERY,
  JobHitSchema,
  JobSearchRunDetailSchema,
  JobSearchSetupSchema,
  type ApplicationDraft,
  type ApplicationQuestion,
  type JobHit,
  type JobSearchProfile,
  type ModelDraft,
  type MoreAnswers,
  type SearchSource,
  type TailorAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSearchClaude, TailorRequest } from '../jobsearch/claude';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { GAVE_UP_DRAFTING, getHit } from '../repo/jobSearch';
import { ClaudeLimitError } from '../anthropic/limits';
import { RUN_STOPPED_BY_LIMIT } from '../jobsearch/run';
import { consumeRateLimit } from '../auth/rateLimit';
import { createSession } from '../auth/sessions';
import { CHECK_RULE, MANUAL_RUN_RULE, RUN_BUDGET_MS, TAILOR_RULE } from './jobSearch';

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
  /** Every draft hits this Anthropic limit (thrown, as the real client throws it). */
  draftLimit: ClaudeLimitError | null;
  /** Every search throws (not an API error): the run fails. */
  searchFails: boolean;
  /** The next this many searches throw, then they work again. */
  searchFailuresLeft: number;
  /** What every draft reads in the posting about where the job is worked. */
  reads: { workMode: ModelDraft['workMode']; location: string };
  /** Called inside each search, with the deadline it was given. */
  onSearch: ((deadline: number | undefined) => void) | null;
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
  draftLimit: null,
  searchFails: false,
  searchFailuresLeft: 0,
  onSearch: null,
  reads: { workMode: 'unknown', location: '' },
  keywords: [],
  tailorAnswer: null,
  tailorRequests: [],
  tailor(request: TailorRequest) {
    claude.tailorRequests.push(request);
    return Promise.resolve(claude.tailorAnswer);
  },
  // Lead messages are tested in leadMessages.test.ts.
  leadMessage: () => Promise.resolve(null),
  coverLetter: () => Promise.resolve(null),
  tailorPosting: () => Promise.resolve(null),
  search(
    query: string,
    sources: SearchSource[],
    _days: number,
    _usOnly?: boolean,
    deadline?: number,
  ) {
    claude.searches.push({ query, sources });
    claude.onSearch?.(deadline);
    if (claude.searchFails || claude.searchFailuresLeft > 0) {
      claude.searchFailuresLeft = Math.max(0, claude.searchFailuresLeft - 1);
      return Promise.reject(new Error('the search broke'));
    }
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
    if (claude.draftLimit) return Promise.reject(claude.draftLimit);
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
      workMode: claude.reads.workMode,
      location: claude.reads.location,
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
  salaryFloor: null,
  linkedin: 'https://www.linkedin.com/in/pat',
  portfolio: '',
  website: '',
  workModes: ['Remote', 'Hybrid'],
  commuteArea: [],
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
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(async () => {
    claude.links = [101, 102, 103, 104].map(jobLink);
    claude.results = {};
    claude.searches = [];
    claude.drafts = 0;
    claude.draftsFail = false;
    claude.draftLimit = null;
    claude.searchFails = false;
    claude.searchFailuresLeft = 0;
    claude.onSearch = null;
    claude.reads = { workMode: 'unknown', location: '' };
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
  /** A knock from the hourly schedule. */
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
      // iCIMS needs an account, and its page could not be read: listed to finish by hand, with
      // a reminder that nothing says where it is.
      expect(byRole(hits, 'Senior Product Manager')).toMatchObject({
        source: 'icims',
        company: 'Initech',
        kind: 'finish_yourself',
        reason:
          "iCIMS needs an account at each company; the location doesn't name a country, so check it is in the US (from the search result only)",
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

    it('saves a commute area with the setup', async () => {
      const { cookie } = await member();
      const area = ['Charlotte', 'Concord'];
      expect(
        (await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, commuteArea: area }))
          .statusCode,
      ).toBe(200);
      const setup = parsed(JobSearchSetupSchema)(
        await send('GET', '/api/job-search/profile', cookie),
      );
      expect(setup.profile?.commuteArea).toEqual(area);
    });

    it('reads where a job is worked from its posting when the board does not say', async () => {
      const { cookie } = await member();
      await send('PUT', '/api/job-search/profile', cookie, {
        ...PROFILE,
        workModes: ['Remote', 'Hybrid', 'On-site'],
        commuteArea: ['Charlotte', 'Concord'],
        state: 'NC',
      });
      // The board gives only the country and no work mode (a city in another state would be
      // skipped before any posting is read); the draft reads the posting.
      PAGES[apiUrl(108)] = greenhouseJob(
        'Product Manager, Payments',
        2,
        undefined,
        'United States',
      );
      claude.links = [jobLink(108)];
      try {
        claude.reads = { workMode: 'On-site', location: 'Austin, TX' };
        const away = runOf(await run(cookie));
        expect(byRole(away.hits, 'Product Manager, Payments')).toMatchObject({
          kind: 'skipped',
          workMode: 'On-site',
          draft: null,
          reason: 'On-site in Austin, TX: outside your commute area (read in the posting)',
        });
        const queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
        expect([...queue.ready, ...queue.needsYou]).toEqual([]);
        expect(queue.notDrafted).toBe(0);
      } finally {
        delete PAGES[apiUrl(108)];
      }

      // A hybrid job the posting places in the commute area is drafted as usual.
      PAGES[apiUrl(109)] = greenhouseJob('Product Manager, Lending', 2, undefined, 'United States');
      claude.links = [jobLink(109)];
      try {
        claude.reads = { workMode: 'Hybrid', location: 'Charlotte, NC' };
        const near = runOf(await run(cookie));
        const kept = byRole(near.hits, 'Product Manager, Lending');
        expect(kept).toMatchObject({ kind: 'target', workMode: 'Hybrid' });
        expect(kept.draft).not.toBeNull();
      } finally {
        delete PAGES[apiUrl(109)];
      }
    });

    it('skips a job whose posted pay tops out below the floor, and keeps the rest', async () => {
      const { cookie } = await member();
      await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, salaryFloor: 140000 });
      PAGES[apiUrl(106)] = greenhouseJob(
        'Product Manager, Billing',
        2,
        `${'Own billing. '.repeat(20)} Salary range: $100,000 - $130,000 per year.`,
      );
      PAGES[apiUrl(107)] = greenhouseJob(
        'Product Manager, Search',
        2,
        `${'Own search. '.repeat(20)} Salary range: $120,000 - $170,000 per year.`,
      );
      claude.links = [101, 106, 107].map(jobLink);
      try {
        const { hits } = runOf(await run(cookie));
        expect(byRole(hits, 'Product Manager, Billing')).toMatchObject({
          kind: 'skipped',
          reason: 'Pays up to $130,000, under your $140,000 floor',
        });
        // A range reaching the floor, and a job with no pay posted, are kept.
        expect(byRole(hits, 'Product Manager, Search').kind).toBe('target');
        expect(byRole(hits, 'Senior Product Manager').kind).toBe('target');
      } finally {
        delete PAGES[apiUrl(106)];
        delete PAGES[apiUrl(107)];
      }
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

    /** A hit's draft bookkeeping, straight from the table. */
    const attemptsOf = async (id: string) =>
      (
        await t.db.query<{ draft_attempts: number; draft_error: string | null; state: string }>(
          'select draft_attempts, draft_error, state from job_search_hits where id = $1',
          [id],
        )
      ).rows[0];

    it('stops a run at a Claude limit: 503, the reason on the run, no draft attempt lost', async () => {
      const { cookie } = await member();
      claude.draftLimit = new ClaudeLimitError('spend_limit', null);

      const response = await run(cookie);

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeUndefined();
      expect(response.json()).toMatchObject({ error: 'claude_limit_reached' });
      const runs = (await send('GET', '/api/job-search/runs', cookie)).json<{
        items: { id: string; status: string; error: string | null }[];
      }>().items;
      expect(runs[0]).toMatchObject({
        status: 'failed',
        error: RUN_STOPPED_BY_LIMIT.spend_limit,
      });
      // The jobs found are kept, and none of them counts a failed try.
      const { hits } = runOf(
        await send('GET', `/api/job-search/runs/${runs[0]?.id ?? ''}`, cookie),
      );
      expect(hits.length).toBeGreaterThan(0);
      const target = byRole(hits, 'Senior Product Manager');
      expect(await attemptsOf(target.id)).toEqual({
        draft_attempts: 0,
        draft_error: null,
        state: 'new',
      });
      // The first refusal stops the others: no more drafts start after it.
      expect(claude.drafts).toBeLessThanOrEqual(2);

      // Once the limit is gone, the next knock drafts it.
      claude.draftLimit = null;
      await cron(CRON_SECRET);
      expect((await attemptsOf(target.id))?.state).not.toBe('new');
    });

    it('answers a busy Claude with 503 and its retry-after on Redraft', async () => {
      const { cookie } = await member();
      claude.draftsFail = true;
      const target = byRole(runOf(await run(cookie)).hits, 'Senior Product Manager');
      claude.draftLimit = new ClaudeLimitError('rate_limited', 17);

      const response = await send('POST', `/api/job-search/hits/${target.id}/redraft`, cookie);

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('17');
      expect(response.json()).toMatchObject({ error: 'claude_busy' });
      // Only the try from the run counts.
      expect((await attemptsOf(target.id))?.draft_attempts).toBe(1);
    });

    it('stops drafting a job after 3 failed tries, moving it to Needs you until Redraft', async () => {
      const { cookie } = await member();
      claude.draftsFail = true;
      const { hits } = runOf(await run(cookie)); // try 1
      const target = byRole(hits, 'Senior Product Manager');
      // T0 is 07:00 in New York, before the run hour: the knocks only draft (tries 2 and 3).
      await cron(CRON_SECRET);
      await cron(CRON_SECRET);
      const stuck = byRole(
        runOf(await send('GET', `/api/job-search/runs/${target.runId}`, cookie)).hits,
        'Senior Product Manager',
      );
      expect(stuck).toMatchObject({
        state: 'needs_you',
        draft: null,
        draftError: GAVE_UP_DRAFTING,
      });
      const queue = queueOf(await send('GET', '/api/job-search/queue', cookie));
      expect(queue.needsYou.map((hit) => hit.id)).toContain(target.id);

      // Not drafted again by the schedule.
      const triesSoFar = claude.drafts;
      await cron(CRON_SECRET);
      expect(claude.drafts).toBe(triesSoFar);

      // Redraft by hand still works, and a finished draft clears the error.
      claude.draftsFail = false;
      expect(
        (await send('POST', `/api/job-search/hits/${target.id}/redraft`, cookie)).statusCode,
      ).toBe(200);
      const drafted = byRole(
        runOf(await send('GET', `/api/job-search/runs/${target.runId}`, cookie)).hits,
        'Senior Product Manager',
      );
      expect(drafted.draft).not.toBeNull();
      expect(drafted.draftError).toBeNull();
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
      expect(result.json()).toEqual({ checked: 1, closed: 1, unknown: 1, belowFloor: 0 });

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
      expect((await check(login.cookie)).json()).toEqual({
        checked: 1,
        closed: 0,
        unknown: 0,
        belowFloor: 0,
      });
      const after = queueOf(await send('GET', '/api/job-search/queue', login.cookie));
      expect(after.keywordOnly[0]).toMatchObject({ state: 'new' });
      expect(after.checks.lastCheckedAt).toBe(new Date(T0.getTime() + HOUR).toISOString());
    });

    it('skips a waiting job whose pay is under a floor set after it was found', async () => {
      const login = await member();
      PAGES[apiUrl(106)] = greenhouseJob(
        'Product Manager, Billing',
        2,
        `${'Own billing. '.repeat(20)} Salary range: $100,000 - $130,000 per year.`,
      );
      claude.links = [101, 106].map(jobLink);
      try {
        const { hits } = runOf(await run(login.cookie));
        const lowPay = byRole(hits, 'Product Manager, Billing');
        expect(lowPay.kind).toBe('target');
        await send('PUT', '/api/job-search/profile', login.cookie, {
          ...PROFILE,
          salaryFloor: 140000,
        });
        t.clock.set(new Date(T0.getTime() + HOUR));

        expect((await check(login.cookie)).json()).toEqual({
          checked: 2,
          closed: 0,
          unknown: 0,
          belowFloor: 1,
        });
        const detail = runOf(
          await send('GET', `/api/job-search/runs/${lowPay.runId}`, login.cookie),
        );
        expect(byRole(detail.hits, 'Product Manager, Billing')).toMatchObject({
          kind: 'skipped',
          state: 'skipped',
          reason: 'Pays up to $130,000, under your $140,000 floor',
        });
        // The job with no pay posted stays in the queue.
        expect(byRole(detail.hits, 'Senior Product Manager').state).not.toBe('skipped');
      } finally {
        delete PAGES[apiUrl(106)];
      }
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

    const saveFromQueue = (cookie: string, id: string, text: string) =>
      send('POST', `/api/job-search/hits/${id}/tailored-resume`, cookie, { text });
    const tailoringOfApplication = async (cookie: string, applicationId: string) =>
      ApplicationTailoringSchema.parse(
        (await send('GET', `/api/applications/${applicationId}/tailoring`, cookie)).json(),
      );

    it("saves this job's resume from the queue: tracked as Saved, with the queue's suggestions", async () => {
      const { cookie, target } = await drafted();
      claude.tailorAnswer = {
        edits: [
          {
            original: LINE,
            suggested: 'Senior product manager, eight years of roadmaps written in SQL.',
            keywordsAdded: ['SQL'],
            why: 'Roadmap work.',
          },
        ],
        notCovered: [],
      };
      await tailor(cookie, target.id);
      const resume = (await send('GET', '/api/resume/text', cookie)).json<{ text: string }>().text;
      const text = `${resume}\n- Wrote the SQL behind the growth reports.`;

      const hit = hitOf(await saveFromQueue(cookie, target.id, text));

      // Tracked as Saved, still in the queue.
      expect(hit.state).toBe('needs_you');
      expect(hit.tracked?.status).toBe('Saved');
      const tailoring = await tailoringOfApplication(cookie, hit.applicationId ?? '');
      expect(tailoring.saved).toMatchObject({ text, resumeChanged: false });
      expect(tailoring.saved?.edits).toEqual([
        { original: '', replacement: '- Wrote the SQL behind the growth reports.' },
      ]);
      // The queue's suggestions and the posting keywords came with it.
      expect(tailoring.tailoring?.edits[0]?.keywordsAdded).toEqual(['SQL']);
      expect(tailoring.keywords.map((keyword) => keyword.term)).toEqual(claude.keywords);
    });

    it('saves onto the application already tracked, without a second one', async () => {
      const { cookie, target, user } = await drafted();
      const tracked = hitOf(await send('POST', `/api/job-search/hits/${target.id}/track`, cookie));
      const resume = (await send('GET', '/api/resume/text', cookie)).json<{ text: string }>().text;

      const hit = hitOf(await saveFromQueue(cookie, target.id, `${resume}\n- One more line.`));

      expect(hit.applicationId).toBe(tracked.applicationId);
      const count = await t.db.query<{ n: number }>(
        'select count(*)::int as n from applications where user_id = $1',
        [user.id],
      );
      expect(count.rows[0]?.n).toBe(1);
      expect((await tailoringOfApplication(cookie, hit.applicationId ?? '')).saved).not.toBeNull();
    });

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
        model: 'claude-haiku-5-5',
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

  describe('new setup answers fill jobs already waiting', () => {
    const QUESTIONS: ApplicationQuestion[] = [
      {
        label: 'Are you a U.S. citizen?',
        required: true,
        kind: 'single_select',
        options: ['Yes', 'No'],
      },
      { label: 'What is the country of your birth?', required: true, kind: 'text', options: [] },
      { label: 'Why us?', required: true, kind: 'long_text', options: [] },
    ];
    const DRAFT: ApplicationDraft = {
      answers: [
        { question: 'Are you a U.S. citizen?', answer: '', source: 'needs_you', option: null },
        // Typed by the user on the queue: never overwritten.
        {
          question: 'What is the country of your birth?',
          answer: 'Typed by me',
          source: 'draft',
          option: null,
        },
        { question: 'Why us?', answer: 'The mission.', source: 'draft', option: null },
      ],
      coverLetter: 'Dear team',
      whyInterested: '',
    };
    const MORE: MoreAnswers = { ...EMPTY_MORE_ANSWERS, usCitizen: 'yes', birthCountry: 'Nepal' };

    /** A user whose run left one job needing them, on the questions above. */
    async function waiting() {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      const target = byRole(hits, 'Senior Product Manager');
      await t.db.query(
        `update job_search_hits set questions = $2, draft = $3, state = 'needs_you' where id = $1`,
        [target.id, JSON.stringify(QUESTIONS), JSON.stringify(DRAFT)],
      );
      return { ...login, hitId: target.id };
    }
    const saveSetup = (cookie: string, more = MORE) =>
      send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, more });
    const hitNow = async (userId: string, id: string) => {
      const hit = await getHit(t.db, userId, id);
      if (!hit) throw new Error('hit gone');
      return hit;
    };

    it('moves a needs-you job to ready, by code, leaving typed answers alone', async () => {
      const owner = await waiting();
      const draftsBefore = claude.drafts;

      expect((await saveSetup(owner.cookie)).statusCode).toBe(200);

      const hit = await hitNow(owner.user.id, owner.hitId);
      expect(hit.state).toBe('ready');
      expect(hit.draft?.answers).toEqual([
        { question: 'Are you a U.S. citizen?', answer: 'Yes', source: 'profile', option: 'Yes' },
        DRAFT.answers[1],
        DRAFT.answers[2],
      ]);
      expect(hit.draft?.coverLetter).toBe('Dear team');
      // No model call.
      expect(claude.drafts).toBe(draftsBefore);
      // The saved setup has the answers.
      expect(
        parsed(JobSearchSetupSchema)(await send('GET', '/api/job-search/profile', owner.cookie))
          .profile?.more,
      ).toEqual(MORE);
    });

    it('changes nothing while the answers are not set', async () => {
      const owner = await waiting();

      expect((await saveSetup(owner.cookie, EMPTY_MORE_ANSWERS)).statusCode).toBe(200);

      const hit = await hitNow(owner.user.id, owner.hitId);
      expect(hit.state).toBe('needs_you');
      expect(hit.draft).toEqual(DRAFT);
    });

    it("leaves another user's waiting jobs untouched", async () => {
      const owner = await waiting();
      const other = await waiting();

      await saveSetup(owner.cookie);

      expect((await hitNow(owner.user.id, owner.hitId)).state).toBe('ready');
      const theirs = await hitNow(other.user.id, other.hitId);
      expect(theirs.state).toBe('needs_you');
      expect(theirs.draft).toEqual(DRAFT);
    });
  });

  describe('track a queue job before applying', () => {
    /** A user whose run left the GitLab job waiting in the queue. */
    async function queued() {
      const login = await member();
      const { hits } = runOf(await run(login.cookie));
      return { ...login, hit: byRole(hits, 'Senior Product Manager') };
    }
    const track = (cookie: string, id: string) =>
      send('POST', `/api/job-search/hits/${id}/track`, cookie);
    const applied = (cookie: string, id: string) =>
      send('POST', `/api/job-search/hits/${id}/applied`, cookie);
    const application = async (cookie: string, id: string) =>
      parsed(ApplicationDetailSchema)(await send('GET', `/api/applications/${id}`, cookie));
    const count = async (userId: string) =>
      (
        await t.db.query<{ n: number }>(
          'select count(*)::int as n from applications where user_id = $1',
          [userId],
        )
      ).rows[0]?.n;

    it('saves the job in the tracker as Saved, linked, and keeps it in the queue', async () => {
      const owner = await queued();

      const tracked = hitOf(await track(owner.cookie, owner.hit.id));

      expect(tracked.state).toBe('needs_you');
      expect(tracked.tracked?.status).toBe('Saved');
      expect(tracked.applicationId).toBe(tracked.tracked?.applicationId);
      const saved = await application(owner.cookie, tracked.applicationId ?? '');
      expect(saved).toMatchObject({
        company: 'GitLab',
        role: 'Senior Product Manager',
        status: 'Saved',
        dateApplied: null,
        jobLink: jobLink(101),
      });
      // Tracking again changes nothing.
      expect(hitOf(await track(owner.cookie, owner.hit.id)).applicationId).toBe(
        tracked.applicationId,
      );
      expect(await count(owner.user.id)).toBe(1);
    });

    it('links the application already in the tracker instead of making a second', async () => {
      const owner = await queued();
      const mine = await send('POST', '/api/applications', owner.cookie, {
        company: 'Gitlab, Inc.',
        role: 'Sr. Product Manager',
        status: 'Saved',
      });
      const id = mine.json<{ id: string }>().id;

      expect(hitOf(await track(owner.cookie, owner.hit.id)).applicationId).toBe(id);
      expect(await count(owner.user.id)).toBe(1);
    });

    it('Mark applied moves the Saved application to Applied, in its history', async () => {
      const owner = await queued();
      const id = hitOf(await track(owner.cookie, owner.hit.id)).applicationId ?? '';

      const done = hitOf(await applied(owner.cookie, owner.hit.id));

      expect(done).toMatchObject({ state: 'applied', applicationId: id });
      const record = await application(owner.cookie, id);
      expect(record.status).toBe('Applied');
      expect(record.dateApplied).not.toBeNull();
      expect(record.history.map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
        [null, 'Saved'],
        ['Saved', 'Applied'],
      ]);
      expect(await count(owner.user.id)).toBe(1);
    });

    it('Mark applied never moves an application further along back to Applied', async () => {
      const owner = await queued();
      const mine = await send('POST', '/api/applications', owner.cookie, {
        company: 'GitLab',
        role: 'Senior Product Manager',
        status: 'Interviewing',
      });
      const id = mine.json<{ id: string }>().id;

      expect(hitOf(await applied(owner.cookie, owner.hit.id)).applicationId).toBe(id);
      expect((await application(owner.cookie, id)).status).toBe('Interviewing');
      expect(await count(owner.user.id)).toBe(1);
    });

    it('Mark applied on an untracked job creates the application, as before', async () => {
      const owner = await queued();
      const done = hitOf(await applied(owner.cookie, owner.hit.id));
      expect((await application(owner.cookie, done.applicationId ?? '')).status).toBe('Applied');
    });

    const letterOf = async (cookie: string, id: string) =>
      parsed(ApplicationCoverLetterSchema)(
        await send('GET', `/api/applications/${id}/cover-letter`, cookie),
      ).coverLetter;

    it("copies the queue's cover letter to the application when the job is tracked", async () => {
      const owner = await queued();
      expect(owner.hit.draft?.coverLetter).toBe('Dear Acme team, ...');

      const id = hitOf(await track(owner.cookie, owner.hit.id)).applicationId ?? '';

      expect(await letterOf(owner.cookie, id)).toMatchObject({
        text: 'Dear Acme team, ...',
        length: 'short',
        tone: 'professional',
        steer: '',
        savedAt: T0.toISOString(),
        resumeChanged: false,
      });
    });

    it("copies it on Mark applied too, and never replaces the application's own letter", async () => {
      const fresh = await queued();
      const created = hitOf(await applied(fresh.cookie, fresh.hit.id)).applicationId ?? '';
      expect((await letterOf(fresh.cookie, created))?.text).toBe('Dear Acme team, ...');

      const owner = await queued();
      const mine = (
        await send('POST', '/api/applications', owner.cookie, {
          company: 'GitLab',
          role: 'Senior Product Manager',
          status: 'Saved',
        })
      ).json<{ id: string }>().id;
      await send('PUT', `/api/applications/${mine}/cover-letter`, owner.cookie, {
        text: 'My own letter',
      });

      expect(hitOf(await track(owner.cookie, owner.hit.id)).applicationId).toBe(mine);
      hitOf(await applied(owner.cookie, owner.hit.id));
      expect((await letterOf(owner.cookie, mine))?.text).toBe('My own letter');
    });

    it('copies nothing when the queue job has no letter', async () => {
      const owner = await queued();
      await t.db.query(
        `update job_search_hits set draft = jsonb_set(draft, '{coverLetter}', '""') where id = $1`,
        [owner.hit.id],
      );
      const id = hitOf(await track(owner.cookie, owner.hit.id)).applicationId ?? '';
      expect(await letterOf(owner.cookie, id)).toBeNull();
    });

    it('refuses a job that has left the queue', async () => {
      const owner = await queued();
      await send('POST', `/api/job-search/hits/${owner.hit.id}/skip`, owner.cookie);
      const response = await track(owner.cookie, owner.hit.id);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'not_in_queue' });
      expect(await count(owner.user.id)).toBe(0);
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
        ['POST', `/api/job-search/hits/{id}/track`, undefined],
        ['POST', `/api/job-search/hits/{id}/tailored-resume`, { text: 'Mine now' }],
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

  describe('the time budget', () => {
    it('stops searching at the deadline and still finishes the run with what it found', async () => {
      const { cookie } = await member();
      await send('PUT', '/api/job-search/profile', cookie, {
        ...PROFILE,
        queries: ['"product manager"', '"engineering manager"'],
      });
      const deadlines: (number | undefined)[] = [];
      claude.onSearch = (deadline) => {
        deadlines.push(deadline);
        // The first search uses up the whole budget.
        vi.setSystemTime(Date.now() + RUN_BUDGET_MS + 1_000);
      };
      const before = Date.now();

      const detail = runOf(await run(cookie));

      expect(claude.searches).toHaveLength(1);
      expect(deadlines[0]).toBeGreaterThan(before);
      expect(deadlines[0]).toBeLessThanOrEqual(before + RUN_BUDGET_MS + 50);
      expect(detail.run.status).toBe('done');
    });
  });

  describe('the hourly schedule', () => {
    it('answers 404 without the right secret', async () => {
      expect((await cron()).statusCode).toBe(404);
      expect((await cron('wrong-secret-of-a-good-length-000000')).statusCode).toBe(404);
    });

    it('starts a due run once per local day, then only keeps drafting', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      const { cookie } = await member();
      // 13:30 UTC is 08:30 in New York: past the 8:00 run hour.
      t.clock.set(new Date('2026-11-05T13:30:00Z'));

      expect((await cron(CRON_SECRET)).json()).toEqual({
        started: 1,
        drafted: 0,
        failed: 0,
        found: 0,
      });
      expect((await cron(CRON_SECRET)).json()).toEqual({
        started: 0,
        drafted: 0,
        failed: 0,
        found: 0,
      });

      const runs = await send('GET', '/api/job-search/runs', cookie);
      expect(
        runs.json<{ items: { trigger: string }[] }>().items.map((item) => item.trigger),
      ).toEqual(['schedule']);
    });

    it("stops the knock for every user at a Claude limit, which is the whole account's", async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      claude.draftsFail = true;
      // Two users, each with a job waiting to be drafted (their runs' drafts failed once).
      for (let index = 0; index < 2; index += 1) runOf(await run((await member()).cookie));
      claude.draftsFail = false;
      claude.draftLimit = new ClaudeLimitError('overloaded', null);
      claude.drafts = 0;

      // 07:00 in New York is before the run hour: the knock only drafts.
      const answer = (await cron(CRON_SECRET)).json<{ failed: number }>();

      // The first user's drafting hits the limit; the second is not tried at all.
      expect(answer.failed).toBe(1);
      expect(claude.drafts).toBeLessThanOrEqual(2);
    });

    it('retries a failed scheduled run on later knocks, at most 3 tries a day', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      const { cookie } = await member();
      const statuses = async () =>
        (await send('GET', '/api/job-search/runs', cookie))
          .json<{ items: { status: string }[] }>()
          .items.map((item) => item.status);
      claude.searchFails = true;
      for (const [index, at] of ['13:30', '14:17', '15:17', '16:17'].entries()) {
        t.clock.set(new Date(`2026-11-05T${at}:00Z`));
        await cron(CRON_SECRET);
        expect((await statuses()).length, `knock at ${at}`).toBe(Math.min(index + 1, 3));
      }
      expect(await statuses()).toEqual(['failed', 'failed', 'failed']);

      // The next day starts fresh, and a finished run ends that day.
      claude.searchFails = false;
      t.clock.set(new Date('2026-11-06T13:30:00Z'));
      expect((await cron(CRON_SECRET)).json()).toMatchObject({ started: 1 });
      t.clock.set(new Date('2026-11-06T14:17:00Z'));
      expect((await cron(CRON_SECRET)).json()).toMatchObject({ started: 0 });
      expect((await statuses())[0]).toBe('done');
    });

    it('keeps going for the next user when one user’s turn fails', async () => {
      env['JOB_SEARCH_USER_IDS'] = '';
      await member();
      const second = await member();
      t.clock.set(new Date('2026-11-05T13:30:00Z')); // 08:30 in New York: both are due
      // The default setup has one query: the first user's only search throws.
      claude.searchFailuresLeft = 1;
      const response = await cron(CRON_SECRET);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ started: 1, drafted: 0, failed: 1, found: 0 });
      const runs = await send('GET', '/api/job-search/runs', second.cookie);
      expect(runs.json<{ items: { status: string }[] }>().items.map((item) => item.status)).toEqual(
        ['done'],
      );
    });

    it('deletes expired sessions and rate-limit windows on each knock', async () => {
      const { user } = await t.login();
      await createSession(t.db, user.id, new Date(T0.getTime() - 2 * HOUR), HOUR); // expired
      await createSession(t.db, user.id, T0, 10 * HOUR); // live
      const rule = { name: 'housekeeping-test', limit: 5, windowMs: HOUR };
      await consumeRateLimit(
        t.db,
        'housekeeping-test:old',
        rule,
        new Date(T0.getTime() - 48 * HOUR),
      );
      await consumeRateLimit(t.db, 'housekeeping-test:new', rule, T0);

      expect((await cron(CRON_SECRET)).statusCode).toBe(200);

      const sessions = await t.db.query<{ expires_at: Date }>(
        'select expires_at from sessions where user_id = $1',
        [user.id],
      );
      // The login's own session and the live one; the expired one is gone.
      expect(sessions.rows).toHaveLength(2);
      for (const row of sessions.rows)
        expect(row.expires_at.getTime()).toBeGreaterThan(T0.getTime());
      const windows = await t.db.query<{ key: string }>(
        "select key from rate_limits where key like 'housekeeping-test:%'",
      );
      expect(windows.rows.map((row) => row.key)).toEqual(['housekeeping-test:new']);
    });

    describe('the hourly board sweep', () => {
      const LIST = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs';
      const listed = (id: number, title: string) => ({
        ...GREENHOUSE,
        id,
        title,
        absolute_url: jobLink(id),
        first_published: new Date(T0.getTime() - HOUR).toISOString(),
      });
      const runsOf = async (cookie: string) =>
        (await send('GET', '/api/job-search/runs', cookie)).json<{
          items: { id: string; trigger: string; status: string }[];
        }>().items;

      it('reads every watched board on a knock, and saves a new job under a sweep run', async () => {
        env['JOB_SEARCH_USER_IDS'] = '';
        const { cookie, user } = await member();
        await run(cookie); // The search finds Acme: its board is watched from now on.
        const boards = await t.db.query<{ source: string; board: string; added_by: string }>(
          'select source, board, added_by from job_search_boards where user_id = $1',
          [user.id],
        );
        expect(boards.rows).toContainEqual({
          source: 'greenhouse',
          board: 'acme',
          added_by: 'search',
        });
        try {
          // T0 is 07:00 in New York, before the run hour: the knock sweeps. Nothing new: no run.
          // A minute on, so the sweep's run is the latest (the clock is frozen otherwise).
          t.clock.set(new Date(T0.getTime() + 60_000));
          PAGES[LIST] = JSON.stringify({ jobs: [listed(101, 'Senior Product Manager')] });
          expect((await cron(CRON_SECRET)).json()).toMatchObject({ started: 0, found: 0 });
          expect((await runsOf(cookie)).map((entry) => entry.trigger)).toEqual(['manual']);

          // A job posted since: read, sorted, saved under a sweep run, and drafted on the same knock.
          PAGES[apiUrl(110)] = greenhouseJob('Product Manager, Risk', 1);
          PAGES[LIST] = JSON.stringify({
            jobs: [listed(101, 'Senior Product Manager'), listed(110, 'Product Manager, Risk')],
          });
          const draftsBefore = claude.drafts;
          expect((await cron(CRON_SECRET)).json()).toMatchObject({ started: 0, found: 1 });
          expect(claude.drafts).toBe(draftsBefore + 1);
          expect(claude.searches).toHaveLength(1); // No web search: only the first run's.
          const [latest] = await runsOf(cookie);
          expect(latest).toMatchObject({ trigger: 'sweep', status: 'done' });
          const detail = runOf(
            await send('GET', `/api/job-search/runs/${latest?.id ?? ''}`, cookie),
          );
          const fresh = byRole(detail.hits, 'Product Manager, Risk');
          expect(fresh.kind).toBe('target');
          expect(fresh.draft).not.toBeNull();

          // The same job is never saved twice.
          expect((await cron(CRON_SECRET)).json()).toMatchObject({ found: 0 });
          expect(await runsOf(cookie)).toHaveLength(2);
        } finally {
          delete PAGES[LIST];
          delete PAGES[apiUrl(110)];
        }
      });

      it('reads a watched Workday site, keeping a new job from what its list says', async () => {
        env['JOB_SEARCH_USER_IDS'] = '';
        const { cookie, user } = await member();
        await t.db.query(
          "insert into job_search_boards (user_id, source, board, added_by) values ($1, 'workday', 'initech.wd5/External', 'user')",
          [user.id],
        );
        const WORKDAY = 'https://initech.wd5.myworkdayjobs.com/wday/cxs/initech/External/jobs';
        try {
          PAGES[WORKDAY] = JSON.stringify({
            total: 2,
            jobPostings: [
              {
                title: 'Senior Product Manager',
                externalPath: '/job/Remote-US/Senior-Product-Manager_R77',
                postedOn: 'Posted Today',
              },
              {
                title: 'Staff Accountant',
                externalPath: '/job/Remote-US/Staff-Accountant_R78',
                postedOn: 'Posted Today',
              },
            ],
          });
          expect((await cron(CRON_SECRET)).json()).toMatchObject({ found: 1 });
          const [latest] = await runsOf(cookie);
          expect(latest).toMatchObject({ trigger: 'sweep', status: 'done' });
          const detail = runOf(
            await send('GET', `/api/job-search/runs/${latest?.id ?? ''}`, cookie),
          );
          expect(detail.hits).toHaveLength(1);
          // Workday needs an account: the job is listed to finish by hand.
          expect(detail.hits[0]).toMatchObject({
            source: 'workday',
            role: 'Senior Product Manager',
            kind: 'finish_yourself',
            jobLink:
              'https://initech.wd5.myworkdayjobs.com/External/job/Remote-US/Senior-Product-Manager_R77',
          });
          const board = await t.db.query<{ last_error: string | null; last_swept_at: Date | null }>(
            "select last_error, last_swept_at from job_search_boards where user_id = $1 and source = 'workday'",
            [user.id],
          );
          expect(board.rows).toEqual([{ last_error: null, last_swept_at: T0 }]);
        } finally {
          delete PAGES[WORKDAY];
        }
      });

      it('notes a board that cannot be read, and reads it again next time', async () => {
        env['JOB_SEARCH_USER_IDS'] = '';
        const { cookie, user } = await member();
        await run(cookie);
        const board = async () =>
          (
            await t.db.query<{ last_swept_at: Date | null; last_error: string | null }>(
              "select last_swept_at, last_error from job_search_boards where user_id = $1 and board = 'acme'",
              [user.id],
            )
          ).rows[0];
        TIMING_OUT.add(LIST);
        expect((await cron(CRON_SECRET)).statusCode).toBe(200);
        expect((await board())?.last_error).toBe('slow board');
        TIMING_OUT.clear();
        try {
          PAGES[LIST] = JSON.stringify({ jobs: [] });
          await cron(CRON_SECRET);
          expect(await board()).toMatchObject({ last_error: null, last_swept_at: T0 });
        } finally {
          delete PAGES[LIST];
        }
      });
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
      expect((await cron(CRON_SECRET)).json()).toEqual({
        started: 0,
        drafted: 0,
        failed: 0,
        found: 0,
      });

      await send('PUT', '/api/job-search/profile', cookie, { ...PROFILE, scheduleOn: false });
      t.clock.set(new Date('2026-11-05T15:00:00Z'));
      expect((await cron(CRON_SECRET)).json()).toEqual({
        started: 0,
        drafted: 0,
        failed: 0,
        found: 0,
      });
    });
  });
});
