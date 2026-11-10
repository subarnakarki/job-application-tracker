import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOARDS } from './boards';
import { dayOf, locationOf, salaryInText, workModeOf } from './details';
import { FetchError, type PageFetcher } from './fetchPage';
import { previewPosting } from './preview';

/** Real responses from each board's public API, saved and trimmed (see ./fixtures). */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** The job search's saved pages, for the boards it read first. */
const searchFixture = (name: string) =>
  readFileSync(new URL(`../jobsearch/fixtures/${name}`, import.meta.url), 'utf8');

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

describe('a salary written in the posting text', () => {
  it('takes the range labelled as the salary range, not the ones by state below it', () => {
    expect(
      salaryInText(
        '<p>Salary Range (unless otherwise noted below): $139,800.00 - $223,700.00</p>' +
          '<p>Full Salary Range for position: California: $160,800.00 - $279,600.00&amp;#xa;' +
          'Colorado: $139,800.00 - $246,100.00</p>',
      ),
    ).toEqual({ min: 139800, max: 223700, currency: 'USD' });
    expect(salaryInText('Pay range: €55.000 – €70.000')).toBeNull(); // dots as thousands: not guessed
    expect(salaryInText('Base pay range £60,000 to £75,000 a year')).toEqual({
      min: 60000,
      max: 75000,
      currency: 'GBP',
    });
  });

  it('takes an unlabelled range only when every range agrees, and never an hourly one', () => {
    expect(salaryInText('We pay $120,000 - $150,000.')).toEqual({
      min: 120000,
      max: 150000,
      currency: 'USD',
    });
    expect(salaryInText('NY: $150,000 - $180,000. TX: $130,000 - $160,000.')).toBeNull();
    expect(salaryInText('Salary range: $25 - $32 per hour')).toBeNull();
    expect(salaryInText('No pay here.')).toBeNull();
  });
});

describe('reading a posting link on each job board', () => {
  it('Workday: its pages are drawn by script, so the posting’s own JSON is read', async () => {
    const api =
      'https://alliancedata.wd5.myworkdayjobs.com/wday/cxs/alliancedata/breadfinancial_US/job/Senior-Staff---Quality-Assurance-Engineer_R1013353-1';
    const fetcher = pages({ [api]: fixture('workday-job.json') });
    const link =
      'https://alliancedata.wd5.myworkdayjobs.com/en-US/breadfinancial_US/job/Senior-Staff---Quality-Assurance-Engineer_R1013353-1';
    expect(await previewPosting(link, fetcher)).toEqual({
      jobLink: link,
      company: 'Bread Financial Payments, Inc',
      role: 'Senior Staff - Quality Assurance Engineer',
      salaryMin: 139800,
      salaryMax: 223700,
      salaryCurrency: 'USD',
      location: 'Columbus, OH; Chadds Ford, PA; Frisco, TX (+2 more)',
      workMode: null,
      postedOn: '2026-10-30',
    });
    expect(fetcher.asked).toEqual([api]);

    // The link with a place in it reads the same JSON path.
    const withPlace = pages({});
    await previewPosting(
      'https://alliancedata.wd5.myworkdayjobs.com/breadfinancial_US/job/Columbus-OH/Senior-Staff---Quality-Assurance-Engineer_R1013353-1',
      withPlace,
    ).catch(() => null);
    expect(withPlace.asked).toEqual([
      'https://alliancedata.wd5.myworkdayjobs.com/wday/cxs/alliancedata/breadfinancial_US/job/Columbus-OH/Senior-Staff---Quality-Assurance-Engineer_R1013353-1',
    ]);
  });

  it('Zoho Recruit: no JobPosting data, so the job array its page script is drawn from is read', async () => {
    const page = 'https://quoris.zohorecruit.com/jobs/Careers/837266000007382093';
    const fetcher = pages({ [page]: fixture('zoho-job-page.html') });
    const link = `${page}/Healthcare-QA-Testing-Lead?source=CareerSite`;
    expect(await previewPosting(link, fetcher)).toEqual({
      jobLink: link,
      company: 'Quoris, LLC',
      role: 'Healthcare QA Testing Lead',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      location: null,
      workMode: 'Remote',
      postedOn: '2026-10-30',
    });
    expect(fetcher.asked).toEqual([page]);
  });

  it('Zoho Recruit: a salary and a place, when the job gives them', async () => {
    const page = 'https://quoris.zohorecruit.com/jobs/Careers/837266000007382093';
    const filled = fixture('zoho-job-page.html')
      .replace('\\x22Salary\\x22:null', '\\x22Salary\\x22:\\x22$95,000 - $120,000\\x22')
      .replace('\\x22City\\x22:null', '\\x22City\\x22:\\x22Austin\\x22')
      .replace('\\x22State\\x22:null', '\\x22State\\x22:\\x22Texas\\x22')
      .replace('\\x22Remote_Job\\x22:true', '\\x22Remote_Job\\x22:false');
    expect(await previewPosting(page, pages({ [page]: filled }))).toMatchObject({
      salaryMin: 95000,
      salaryMax: 120000,
      salaryCurrency: 'USD',
      location: 'Austin, Texas',
      workMode: null,
    });
  });

  it('Zoho Recruit: a page whose job array lacks the linked job says nothing', async () => {
    const page = 'https://quoris.zohorecruit.com/jobs/Careers/837266000000000001';
    await expect(
      previewPosting(page, pages({ [page]: fixture('zoho-job-page.html') })),
    ).rejects.toMatchObject({ code: 'no_posting_data' });
  });

  it('Workable: the page is drawn by script, so the account’s public job list is read', async () => {
    const list = 'https://apply.workable.com/api/v1/widget/accounts/huggingface';
    const fetcher = pages({ [list]: searchFixture('workable-account.json') });
    const link = 'https://apply.workable.com/huggingface/j/19a136f8e2/';
    expect(await previewPosting(link, fetcher)).toEqual({
      jobLink: link,
      company: 'Hugging Face',
      role: 'Open-Source Machine Learning Engineer - US Remote',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      location: expect.stringMatching(/United States$/) as unknown,
      workMode: 'Remote',
      postedOn: '2026-05-29',
    });
    expect(fetcher.asked).toEqual([list]);

    // A job no longer in the list says nothing.
    await expect(
      previewPosting('https://apply.workable.com/huggingface/j/000000AAAA/', fetcher),
    ).rejects.toMatchObject({ code: 'no_posting_data' });
  });

  it('Jobvite: no API and no JobPosting data, so the page’s own markup is read', async () => {
    const link = 'https://jobs.jobvite.com/nutanix/job/oFBIAfwi';
    const fetcher = pages({ [link]: searchFixture('jobvite-job.html') });
    const preview = await previewPosting(link, fetcher);
    expect(preview).toMatchObject({
      jobLink: link,
      company: 'Nutanix',
      role: 'Service Providers Sales Systems Engineer',
      salaryMin: null,
      postedOn: null,
    });
    expect(preview.location).toMatch(/^Omaha, Nebraska; Minneapolis, Minnesota/);

    // A closed job lands on the company's job list: no title, so nothing is filled.
    const closed = pages({ [link]: '<title>Nutanix Careers</title><h1>Open jobs</h1>' });
    await expect(previewPosting(link, closed)).rejects.toMatchObject({
      code: 'no_posting_data',
    });
  });

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
