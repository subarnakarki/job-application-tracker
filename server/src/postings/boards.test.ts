import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOARDS } from './boards';
import { dayOf, locationOf, workModeOf } from './details';
import { FetchError, type PageFetcher } from './fetchPage';
import { previewPosting } from './preview';

/** Real responses from each board's public API, saved and trimmed (see ./fixtures). */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function pages(map: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    const text = map[url];
    return text === undefined
      ? Promise.reject(new FetchError('http_status', '404'))
      : Promise.resolve({ url, contentType: 'application/json', text });
  };
  return Object.assign(fetcher, { asked });
}

describe('posting details helpers', () => {
  it('reads a posting date as the posting says it, whatever the format', () => {
    expect(dayOf('2026-10-26T11:38:33.947000-07:00')).toBe('2026-10-26');
    expect(dayOf('2025-01-02 14:22:42 UTC')).toBe('2025-01-02');
    expect(dayOf(1786469891368)).toBe('2026-08-11');
    expect(dayOf('soon')).toBeNull();
    expect(dayOf('2026-02-30')).toBeNull();
  });

  it('knows the three work modes in their many spellings', () => {
    expect(
      ['remote', 'TELECOMMUTE', 'Hybrid', 'OnSite', 'on-site', 'In office'].map(workModeOf),
    ).toEqual(['Remote', 'Remote', 'Hybrid', 'On-site', 'On-site', 'On-site']);
    expect(workModeOf('unspecified')).toBeNull();
  });

  it('lists up to three places, then how many more', () => {
    expect(locationOf(['Boston, MA', 'Boston, MA', 'NYC'])).toBe('Boston, MA; NYC');
    expect(locationOf(['A', 'B', 'C', 'D', 'E'])).toBe('A; B; C (+2 more)');
    expect(locationOf([null, '  '])).toBeNull();
  });
});

describe('reading a posting link on each job board', () => {
  it('Greenhouse: title, company, place, posting date and a yearly salary (in cents)', async () => {
    const job = JSON.parse(fixture('greenhouse-job-pay.json')) as { id: number };
    const fetch = pages({
      [`https://boards-api.greenhouse.io/v1/boards/figma/jobs/${job.id}?pay_transparency=true`]:
        fixture('greenhouse-job-pay.json'),
    });
    expect(
      await previewPosting(`https://job-boards.greenhouse.io/figma/jobs/${job.id}`, fetch),
    ).toMatchObject({
      company: 'Figma',
      role: 'Account Executive, Enterprise',
      salaryMin: 165000,
      salaryMax: 190000,
      salaryCurrency: 'USD',
    });
  });

  it('Rippling: its pages carry no JobPosting data, so its public board API is read', async () => {
    const pay = JSON.parse(fixture('rippling-job-pay.json')) as { uuid: string };
    const fetch = pages({
      [`https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs/${pay.uuid}`]:
        fixture('rippling-job-pay.json'),
    });
    const preview = await previewPosting(
      `https://ats.rippling.com/en-US/rippling/jobs/${pay.uuid}`,
      fetch,
    );
    expect(preview).toMatchObject({
      company: 'Rippling',
      role: 'Business Operations Manager',
      location: 'San Francisco, CA; New York, NY',
      salaryMin: 185000,
      salaryMax: 240000,
      salaryCurrency: 'USD',
      workMode: null,
    });

    // Two different pay ranges (by location): no salary is guessed.
    const tiers = JSON.parse(fixture('rippling-job-pay.json')) as {
      payRangeDetails: Record<string, unknown>[];
    };
    tiers.payRangeDetails.push({
      ...tiers.payRangeDetails[0],
      rangeStart: 150000,
      rangeEnd: 200000,
    });
    const twoRanges = pages({
      [`https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs/${pay.uuid}`]:
        JSON.stringify(tiers),
    });
    expect(
      (await previewPosting(`https://ats.rippling.com/rippling/jobs/${pay.uuid}`, twoRanges))
        .salaryMin,
    ).toBeNull();

    const single = JSON.parse(fixture('rippling-job.json')) as { uuid: string };
    const plain = pages({
      [`https://api.rippling.com/platform/api/ats/v1/board/rippling/jobs/${single.uuid}`]:
        fixture('rippling-job.json'),
    });
    expect(
      await previewPosting(`https://ats.rippling.com/rippling/jobs/${single.uuid}`, plain),
    ).toMatchObject({ role: 'Account Executive, Broker Channel (Boston)', location: 'Boston, MA' });
  });

  it('SmartRecruiters: the posting API, with its remote and hybrid flags', async () => {
    const job = JSON.parse(fixture('smartrecruiters-job.json')) as { id: string };
    const fetch = pages({
      [`https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/${job.id}`]: fixture(
        'smartrecruiters-job.json',
      ),
    });
    expect(
      await previewPosting(
        `https://jobs.smartrecruiters.com/smartrecruiters/${job.id}-senior-lead-engineering-operations-manager`,
        fetch,
      ),
    ).toMatchObject({
      company: 'SmartRecruiters Inc',
      role: 'Senior / Lead Engineering Operations Manager',
      workMode: 'Remote',
      location: 'Poland, Remote, Poland',
      postedOn: '2026-10-28',
    });
  });

  it('Breezy and Recruitee: the job is found in the board list by its id or slug', async () => {
    const [breezyJob] = JSON.parse(fixture('breezy-board.json')) as { friendly_id: string }[];
    const breezy = pages({ 'https://breezy.breezy.hr/json': fixture('breezy-board.json') });
    expect(
      await previewPosting(`https://breezy.breezy.hr/p/${breezyJob?.friendly_id ?? ''}`, breezy),
    ).toMatchObject({
      company: 'MS Breezy Trial',
      role: 'Employee #12',
      location: 'Chaos, FL',
      salaryMin: null,
    });

    const offers = JSON.parse(fixture('recruitee-offers.json')) as { offers: { slug: string }[] };
    const recruitee = pages({
      'https://bunq.recruitee.com/api/offers/': fixture('recruitee-offers.json'),
    });
    expect(
      await previewPosting(
        `https://bunq.recruitee.com/o/${offers.offers[0]?.slug ?? ''}`,
        recruitee,
      ),
    ).toMatchObject({
      company: 'bunq',
      role: 'AML Manager, Austria',
      location: 'Vienna, Austria',
      workMode: 'Hybrid',
      postedOn: '2026-10-30',
    });
  });

  it('Personio and other career sites: the JobPosting data on the page', async () => {
    const fetch = pages({
      'https://ottonova.jobs.personio.de/job/2573573': fixture('personio-job-page.html'),
    });
    const preview = await previewPosting('https://ottonova.jobs.personio.de/job/2573573', fetch);
    expect(preview.role).toMatch(/Aktuar/);
    expect(preview.location).toMatch(/München/);
  });

  it('only builds API links from ids that look right', async () => {
    const fetch = pages({});
    // Not a uuid / not numeric: read as an ordinary page, so no API URL is built from it.
    await expect(
      previewPosting('https://ats.rippling.com/acme/jobs/..%2F..%2Fsecret', fetch),
    ).rejects.toThrow();
    await expect(previewPosting('https://evil.breezy.hr/p/not-hex', fetch)).rejects.toThrow();
    expect(
      fetch.asked.every((url) => !url.includes('api.rippling.com') && !url.endsWith('/json')),
    ).toBe(true);
  });
});

describe('listing a company’s open jobs on each board', () => {
  it.each([
    ['greenhouse', 'stripe', 'greenhouse-board.json', 3],
    ['lever', 'palantir', 'lever-board.json', 2],
    ['ashby', 'ramp', 'ashby-board.json', 2],
    ['rippling', 'rippling', 'rippling-board.json', 3],
    ['smartrecruiters', 'smartrecruiters', 'smartrecruiters-board.json', 2],
    ['breezy', 'breezy', 'breezy-board.json', 2],
    ['recruitee', 'bunq', 'recruitee-offers.json', 2],
    ['teamtailor', 'career', 'teamtailor-feed.json', 1],
    ['personio', 'ottonova', 'personio-feed.xml', 2],
  ] as const)('%s: reads every job with its title and https link', (source, slug, file, count) => {
    const jobs = BOARDS[source].parseList(fixture(file), slug);
    expect(jobs).toHaveLength(count);
    for (const job of jobs) {
      expect(job.source).toBe(source);
      expect(job.title.length).toBeGreaterThan(0);
      expect(job.link).toMatch(/^https:\/\//);
    }
  });

  it('keeps what each board says about a job: place, work mode, date', () => {
    const [lever] = BOARDS.lever.parseList(fixture('lever-board.json'), 'palantir');
    expect(lever?.details).toMatchObject({ location: 'Singapore, Singapore', workMode: 'Hybrid' });
    const [ashby] = BOARDS.ashby.parseList(fixture('ashby-board.json'), 'ramp');
    expect(ashby?.details).toMatchObject({ workMode: 'Hybrid', postedOn: '2026-04-07' });
    expect(ashby?.title).toBe('Security Engineer, Cloud');
    const [team] = BOARDS.teamtailor.parseList(fixture('teamtailor-feed.json'), 'career');
    expect(team?.company).toBe('Teamtailor');
    const [personio] = BOARDS.personio.parseList(fixture('personio-feed.xml'), 'ottonova');
    expect(personio?.link).toBe('https://ottonova.jobs.personio.de/job/2573573');
  });

  it('only uses names that can be a subdomain on subdomain boards', () => {
    expect(BOARDS.breezy.listUrl('a.b')).toBeNull();
    expect(BOARDS.personio.listUrl('UPPER')).toBeNull();
    expect(BOARDS.greenhouse.listUrl('acme')).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
    );
  });
});
