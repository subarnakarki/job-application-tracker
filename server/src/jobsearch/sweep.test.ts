import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { sweepBoards, worthReading, type SweepRules } from './sweep';

const NOW = new Date('2026-11-07T12:00:00Z');
const RULES: SweepRules = {
  wanted: ['SDET', 'QA engineer'],
  skipped: ['intern'],
  timeframeDays: 1,
  now: NOW,
};

/** A Greenhouse board list as its API answers (only the fields the reader uses). */
const greenhouseList = (jobs: { id: number; title: string; published: string; url?: string }[]) =>
  JSON.stringify({
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.title,
      first_published: job.published,
      absolute_url: job.url ?? `https://job-boards.greenhouse.io/acme/jobs/${String(job.id)}`,
      location: { name: 'Remote, United States' },
    })),
  });

function fetcher(pages: Record<string, string>): { fetchBoard: PageFetcher; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchBoard: (url) => {
      asked.push(url);
      const text = pages[url];
      return text === undefined
        ? Promise.reject(new FetchError('http_status', '404'))
        : Promise.resolve({ url, contentType: 'application/json', text });
    },
  };
}

describe('sweepBoards', () => {
  it("keeps the board's wanted jobs posted within the timeframe, by day", async () => {
    const { fetchBoard, asked } = fetcher({
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs': greenhouseList([
        { id: 1, title: 'Senior SDET', published: '2026-11-07T08:00:00-04:00' },
        // Posted yesterday: within 24 hours by day.
        { id: 2, title: 'QA Engineer II', published: '2026-11-06T01:00:00Z' },
        { id: 3, title: 'Senior SDET', published: '2026-10-01T00:00:00Z' },
        { id: 4, title: 'Account Executive', published: '2026-11-07T08:00:00Z' },
        { id: 5, title: 'SDET Intern', published: '2026-11-07T08:00:00Z' },
        // A careers-site link: the job is still read on Greenhouse.
        {
          id: 6,
          title: 'Lead SDET',
          published: '2026-11-07T09:00:00Z',
          url: 'https://acme.example/careers?gh_jid=6',
        },
      ]),
    });

    const found = await sweepBoards(
      [
        { source: 'greenhouse', board: 'acme' },
        { source: 'greenhouse', board: 'gone' },
        { source: 'workable', board: 'not-listable' },
      ],
      RULES,
      fetchBoard,
      () => true,
    );

    expect(found.map((ref) => [ref.jobId, ref.link])).toEqual([
      ['1', 'https://job-boards.greenhouse.io/acme/jobs/1'],
      ['2', 'https://job-boards.greenhouse.io/acme/jobs/2'],
      ['6', 'https://job-boards.greenhouse.io/acme/jobs/6'],
    ]);
    // A board that cannot be read is skipped; Workable has no list to read.
    expect(asked).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
      'https://boards-api.greenhouse.io/v1/boards/gone/jobs',
    ]);
  });

  it('stops when the time is up', async () => {
    const { fetchBoard, asked } = fetcher({});
    await sweepBoards([{ source: 'lever', board: 'acme' }], RULES, fetchBoard, () => false);
    expect(asked).toEqual([]);
  });
});

describe('worthReading', () => {
  const job = (title: string, postedOn: string | null) => ({
    source: 'lever' as const,
    title,
    link: 'https://jobs.lever.co/acme/7c9e6679-7425-40de-944b-e07fc1f90ae7',
    company: null,
    details: { company: null, role: title, salary: null, location: null, workMode: null, postedOn },
  });

  it('needs a date: a list without one cannot show what is new', () => {
    expect(worthReading(job('SDET', '2026-11-07'), RULES)).toBe(true);
    expect(worthReading(job('SDET', null), RULES)).toBe(false);
  });

  it('takes every title when there are no wanted words', () => {
    expect(worthReading(job('Anything', '2026-11-07'), { ...RULES, wanted: [] })).toBe(true);
  });
});
