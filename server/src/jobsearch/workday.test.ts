import { describe, expect, it } from 'vitest';
import type { PageFetcher } from '../postings/fetchPage';
import {
  readWorkdayBoard,
  WORKDAY_PAGE_SIZE,
  workdayAddresses,
  workdayBoardOf,
  workdayPostedDays,
} from './workday';

const RULES = {
  wanted: ['SDET', 'QA engineer'],
  skipped: ['intern'],
  timeframeDays: 7,
  now: new Date('2026-11-09T12:00:00Z'),
};

const posting = (title: string, postedOn: string, id: string) => ({
  title,
  externalPath: `/job/Remote-US/${title.replace(/[^A-Za-z0-9]+/g, '-')}_${id}`,
  locationsText: 'Remote, US',
  postedOn,
  bulletFields: [id],
});

/** A board answering page by page, noting what it was asked. */
function board(pages: unknown[][]) {
  const asked: { url: string; json: unknown }[] = [];
  const fetchBoard: PageFetcher = (url, post) => {
    asked.push({ url, json: post?.json });
    const offset = (post?.json as { offset: number }).offset;
    return Promise.resolve({
      url,
      contentType: 'application/json',
      text: JSON.stringify({ total: 999, jobPostings: pages[offset / WORKDAY_PAGE_SIZE] ?? [] }),
    });
  };
  return { asked, fetchBoard };
}
const filler = (count: number, postedOn: string) =>
  Array.from({ length: count }, (_, index) =>
    posting(`Nurse ${String(index)}`, postedOn, `N${String(index)}`),
  );

describe('Workday board names', () => {
  it.each([
    [
      'https://amgen.wd1.myworkdayjobs.com/en-US/Careers/job/US---Remote/QA-Sr-Mgr_R-253749',
      'amgen.wd1/Careers',
    ],
    [
      'https://alsglobal.wd103.myworkdayjobs.com/external/job/QA-Manager_R8828',
      'alsglobal.wd103/external',
    ],
    [
      'https://chg.wd5.myworkdayjobs.com/US_External_Career_Site',
      'chg.wd5/US_External_Career_Site',
    ],
    ['  https://acme.wd5.myworkdayjobs.com/en-US/External/  ', 'acme.wd5/External'],
  ])('%s', (link, name) => {
    expect(workdayBoardOf(link)).toBe(name);
  });

  it.each([
    'https://acme.wd5.myworkdayjobs.com/',
    'https://acme.wd5.myworkdayjobs.com/job/Remote/QA_R1',
    'http://acme.wd5.myworkdayjobs.com/External',
    'https://myworkdayjobs.com/External',
    'https://acme.wd5.myworkdayjobs.com.evil.example/External',
    'not a link',
  ])('refuses %s', (link) => {
    expect(workdayBoardOf(link)).toBeNull();
  });

  it('gives the list address and the base of job links, only for a well-formed name', () => {
    expect(workdayAddresses('amgen.wd1/Careers')).toEqual({
      listUrl: 'https://amgen.wd1.myworkdayjobs.com/wday/cxs/amgen/Careers/jobs',
      jobBase: 'https://amgen.wd1.myworkdayjobs.com/Careers',
    });
    expect(workdayAddresses('amgen')).toBeNull();
    expect(workdayAddresses('evil.example/x')).toBeNull();
    expect(workdayAddresses('a.wd1/../../etc')).toBeNull();
  });
});

describe('workdayPostedDays', () => {
  it.each<[unknown, number | null]>([
    ['Posted Today', 0],
    ['Posted Yesterday', 1],
    ['Posted 3 Days Ago', 3],
    ['Posted 30+ Days Ago', 31],
    ['Posted 1 Day Ago', 1],
    ['', null],
    [undefined, null],
    ['Open until filled', null],
  ])('%s is %s', (text, days) => {
    expect(workdayPostedDays(text)).toBe(days);
  });
});

describe('readWorkdayBoard', () => {
  it('keeps the wanted, recent jobs, as links the search knows', async () => {
    const { asked, fetchBoard } = board([
      [
        posting('Senior SDET', 'Posted Today', 'R1'),
        posting('Lead QA Engineer', 'Posted 3 Days Ago', 'R2'),
        posting('QA Engineer Intern', 'Posted Today', 'R3'),
        posting('Staff Accountant', 'Posted Today', 'R4'),
        posting('SDET II', 'Posted 12 Days Ago', 'R5'),
        { title: 'SDET', postedOn: 'Posted Today' }, // No link: left out.
      ],
    ]);

    const found = await readWorkdayBoard('acme.wd5/External', RULES, fetchBoard);

    expect(found.map((entry) => entry.result)).toEqual([
      { title: 'Senior SDET', pageAge: '0 days ago' },
      { title: 'Lead QA Engineer', pageAge: '3 days ago' },
    ]);
    expect(found[0]?.ref).toEqual({
      source: 'workday',
      board: 'acme',
      jobId: 'Senior-SDET_R1',
      link: 'https://acme.wd5.myworkdayjobs.com/External/job/Remote-US/Senior-SDET_R1',
    });
    expect(asked).toEqual([
      {
        url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
        json: { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
      },
    ]);
  });

  it('reads on while a full page still has jobs from today or yesterday, three pages at most', async () => {
    const busy = board([
      filler(20, 'Posted Today'),
      [...filler(19, 'Posted Yesterday'), posting('SDET', 'Posted Yesterday', 'R9')],
      filler(20, 'Posted Today'),
      filler(20, 'Posted Today'),
    ]);
    const found = await readWorkdayBoard('acme.wd5/External', RULES, busy.fetchBoard);
    expect(found.map((entry) => entry.result.title)).toEqual(['SDET']);
    expect(busy.asked.map((entry) => (entry.json as { offset: number }).offset)).toEqual([
      0, 20, 40,
    ]);

    // A page with nothing new ends the reading.
    const quiet = board([filler(20, 'Posted 5 Days Ago'), filler(20, 'Posted Today')]);
    await readWorkdayBoard('acme.wd5/External', RULES, quiet.fetchBoard);
    expect(quiet.asked).toHaveLength(1);
  });

  it('fails for a name that is not a board, or an answer that is not a list', async () => {
    await expect(readWorkdayBoard('acme', RULES, board([]).fetchBoard)).rejects.toThrow();
    const html: PageFetcher = (url) =>
      Promise.resolve({ url, contentType: 'text/html', text: '<html>Sign in</html>' });
    await expect(readWorkdayBoard('acme.wd5/External', RULES, html)).rejects.toThrow();
  });
});
