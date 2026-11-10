import { boardRefOf, WatchedBoardListSchema, WatchedBoardSchema } from '@jat/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSearchClaude } from '../jobsearch/claude';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { WATCH_RULE } from './jobSearchBoards';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const claude: JobSearchClaude = {
  search: () => Promise.resolve({ links: [], searches: 0 }),
  draft: () => Promise.resolve(null),
  tailor: () => Promise.resolve(null),
  tailorPosting: () => Promise.resolve(null),
  leadMessage: () => Promise.resolve(null),
};

/** Board lists the "network" answers; anything else cannot be read. */
const LISTS: Record<string, string> = {
  'https://boards-api.greenhouse.io/v1/boards/acme/jobs': JSON.stringify({ jobs: [] }),
  'https://api.lever.co/v0/postings/initech?mode=json': JSON.stringify([]),
  'https://hooli.wd5.myworkdayjobs.com/wday/cxs/hooli/External/jobs': JSON.stringify({
    total: 0,
    jobPostings: [],
  }),
};
const fetchPage: PageFetcher = (url) => {
  const text = LISTS[url];
  return text === undefined
    ? Promise.reject(new FetchError('http_status', '404'))
    : Promise.resolve({ url, contentType: 'application/json', text });
};

describe('boardRefOf: the company board a pasted link points at', () => {
  it.each([
    ['https://job-boards.greenhouse.io/acme', { source: 'greenhouse', board: 'acme' }],
    ['https://boards.greenhouse.io/Acme/', { source: 'greenhouse', board: 'acme' }],
    ['https://job-boards.greenhouse.io/acme/jobs/12345', { source: 'greenhouse', board: 'acme' }],
    ['  https://jobs.lever.co/initech  ', { source: 'lever', board: 'initech' }],
    ['https://jobs.ashbyhq.com/Hooli', { source: 'ashby', board: 'Hooli' }],
  ])('%s', (link, board) => {
    expect(boardRefOf(link)).toEqual(board);
  });

  it.each([
    'https://example.com/careers',
    'https://job-boards.greenhouse.io/',
    'https://job-boards.greenhouse.io/embed/job_board?for=acme',
    'javascript:alert(1)',
    'acme',
  ])('refuses %s', (link) => {
    expect(boardRefOf(link)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('companies watched (real app, real database)', () => {
  let t: TestApp;
  const env: Record<string, string> = { JOB_SEARCH_USER_IDS: '' };

  beforeAll(async () => {
    t = await createTestApp({ env, jobSearchClaude: claude, fetchPage });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(T0);
    await t.db.query("delete from rate_limits where key like 'job-search-watch%'");
  });

  const send = (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie },
      ...(payload ? { payload } : {}),
    });
  async function member() {
    const login = await t.login();
    env['JOB_SEARCH_USER_IDS'] = [env['JOB_SEARCH_USER_IDS'], login.user.id]
      .filter(Boolean)
      .join(',');
    return login;
  }
  const watch = (cookie: string, link: string) =>
    send('POST', '/api/job-search/boards', cookie, { link });
  const list = async (cookie: string) =>
    WatchedBoardListSchema.parse((await send('GET', '/api/job-search/boards', cookie)).json());

  it('is closed (404) to a user not on the list', async () => {
    const { cookie } = await t.login();
    expect((await send('GET', '/api/job-search/boards', cookie)).statusCode).toBe(404);
    expect((await watch(cookie, 'https://job-boards.greenhouse.io/acme')).statusCode).toBe(404);
  });

  it('watches a company from a board link or a job link, once', async () => {
    const { cookie } = await member();
    const added = await watch(cookie, 'https://job-boards.greenhouse.io/acme');
    expect(added.statusCode).toBe(201);
    expect(WatchedBoardSchema.parse(added.json())).toMatchObject({
      source: 'greenhouse',
      board: 'acme',
      company: 'Acme',
      addedBy: 'user',
      lastSweptAt: null,
      lastError: null,
    });
    // The same company again, by one of its jobs: still one row.
    expect(
      (await watch(cookie, 'https://job-boards.greenhouse.io/acme/jobs/12345')).statusCode,
    ).toBe(201);
    expect(
      (await watch(cookie, 'https://jobs.lever.co/initech/5ac21346-8e0c-4494-8e7a-3eb92ff77902'))
        .statusCode,
    ).toBe(201);
    const boards = await list(cookie);
    expect(boards.total).toBe(2);
    expect(boards.items.map((board) => board.board).sort()).toEqual(['acme', 'initech']);
  });

  it('watches a Workday site, named by its host and site', async () => {
    const { cookie } = await member();
    const added = await watch(
      cookie,
      'https://hooli.wd5.myworkdayjobs.com/en-US/External/job/Remote-US/Senior-SDET_R1',
    );
    expect(added.statusCode).toBe(201);
    expect(WatchedBoardSchema.parse(added.json())).toMatchObject({
      source: 'workday',
      board: 'hooli.wd5/External',
      company: 'Hooli',
      addedBy: 'user',
    });
    expect((await list(cookie)).items.map((board) => board.board)).toEqual(['hooli.wd5/External']);
  });

  it('refuses a link that is not a readable board, and a company whose board cannot be read', async () => {
    const { cookie } = await member();
    const other = await watch(cookie, 'https://example.com/careers');
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ error: 'unsupported_board' });
    // A Workday site that does not answer.
    expect(
      (await watch(cookie, 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Remote/SDET_R1'))
        .statusCode,
    ).toBe(422);
    const missing = await watch(cookie, 'https://job-boards.greenhouse.io/no-such-company');
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: 'board_unreadable' });
    expect((await send('POST', '/api/job-search/boards', cookie, { link: '' })).statusCode).toBe(
      400,
    );
    expect((await list(cookie)).total).toBe(0);
  });

  it('allows forty adds a day', async () => {
    const { cookie } = await member();
    for (let index = 0; index < WATCH_RULE.limit; index += 1)
      expect((await watch(cookie, 'https://job-boards.greenhouse.io/acme')).statusCode).toBe(201);
    expect((await watch(cookie, 'https://job-boards.greenhouse.io/acme')).statusCode).toBe(429);
  });

  it('stops watching a company; another user gets 404 and changes nothing', async () => {
    const owner = await member();
    const other = await member();
    const added = WatchedBoardSchema.parse(
      (await watch(owner.cookie, 'https://job-boards.greenhouse.io/acme')).json(),
    );
    for (const id of [added.id, MISSING_ID, 'not-a-uuid']) {
      const response = await send('DELETE', `/api/job-search/boards/${id}`, other.cookie);
      expect(response.statusCode, id).toBe(404);
      expect(response.json()).toMatchObject({ error: 'not_found' });
    }
    expect((await list(other.cookie)).total).toBe(0);
    expect((await list(owner.cookie)).total).toBe(1);

    expect(
      (await send('DELETE', `/api/job-search/boards/${added.id}`, owner.cookie)).statusCode,
    ).toBe(204);
    expect((await list(owner.cookie)).total).toBe(0);
    expect(
      (await send('DELETE', `/api/job-search/boards/${added.id}`, owner.cookie)).statusCode,
    ).toBe(404);
  });
});
