import { readFileSync } from 'node:fs';
import { jobRefOf, type JobRef } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { companyFromSlug, JobReadError, readJob } from './readJob';
import { jobFromSearchResult, pageAgeToDate } from './run';

/** Real board answers (trimmed), saved on 2026-11-06. */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function fetcher(pages: Record<string, string>): { fetchPage: PageFetcher; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: (url) => {
      asked.push(url);
      const text = pages[url];
      return text === undefined
        ? Promise.reject(new FetchError('http_status', '404'))
        : Promise.resolve({ url, contentType: 'application/json', text });
    },
  };
}

const ref = (link: string): JobRef => {
  const found = jobRefOf(link);
  if (!found) throw new Error(`not a job link: ${link}`);
  return found;
};

describe('readJob', () => {
  it('reads a Greenhouse job with its questions, EEO questions included', async () => {
    const api =
      'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8638232002?questions=true&pay_transparency=true';
    const { fetchPage, asked } = fetcher({ [api]: fixture('greenhouse-job.json') });

    const job = await readJob(
      ref('https://job-boards.greenhouse.io/gitlab/jobs/8638232002'),
      fetchPage,
    );

    expect(asked).toEqual([api]);
    expect(job).toMatchObject({
      company: 'GitLab',
      location: 'Remote, United States',
      workMode: 'Remote',
      postedAt: new Date('2026-07-22T13:38:40-04:00'),
      applyLink: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
    });
    expect(job.text.length).toBeGreaterThan(200);
    expect(job.text).not.toMatch(/<|&lt;/);
    expect(job.salary).toBeNull(); // no pay posted
    const questions = job.questions ?? [];
    expect(questions.slice(0, 3)).toEqual([
      { label: 'First Name', required: true, kind: 'text', options: [] },
      { label: 'Last Name', required: true, kind: 'text', options: [] },
      { label: 'Email', required: true, kind: 'text', options: [] },
    ]);
    expect(questions.find((question) => question.label === 'Resume/CV')?.kind).toBe('file');
    const sponsorship = questions.find((question) => /sponsorship/.test(question.label));
    expect(sponsorship).toMatchObject({ required: true, kind: 'single_select' });
    expect(sponsorship?.options.length).toBeGreaterThan(1);
    // The EEO block follows the form's own questions.
    expect(questions.slice(14).map((question) => question.label)).toEqual(
      expect.arrayContaining(['VeteranStatus', 'Gender']),
    );
  });

  it("reads Greenhouse's newer demographic block, required flags and options included", async () => {
    const api =
      'https://boards-api.greenhouse.io/v1/boards/discord/jobs/8917177002?questions=true&pay_transparency=true';
    const { fetchPage } = fetcher({ [api]: fixture('greenhouse-job-demographic.json') });

    const job = await readJob(
      ref('https://job-boards.greenhouse.io/discord/jobs/8917177002'),
      fetchPage,
    );

    const byLabel = new Map((job.questions ?? []).map((question) => [question.label, question]));
    expect(byLabel.get('Gender')).toEqual({
      label: 'Gender',
      required: true,
      kind: 'single_select',
      options: ['Male', 'Female', "I don't wish to answer"],
    });
    expect(byLabel.get('Disability Status')?.options).toContain(
      'No, I do not have a disability and have not had one in the past',
    );
    expect(byLabel.has('I consider myself a member of the LGBTQ+ community. (optional)')).toBe(
      true,
    );
    expect(job.salary).toBeNull(); // no pay posted
  });

  it('reads a Lever posting (no questions published) and its apply link', async () => {
    const { fetchPage } = fetcher({
      'https://api.lever.co/v0/postings/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd':
        fixture('lever-posting.json'),
    });
    const job = await readJob(
      ref('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'),
      fetchPage,
    );
    expect(job).toMatchObject({
      company: 'Palantir',
      location: 'Singapore, Singapore',
      workMode: 'Hybrid',
      postedAt: new Date(1786469891368),
      applyLink: 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd/apply',
      questions: null,
    });
    expect(job.text.length).toBeGreaterThan(200);
    expect(job.salary).toBeNull(); // no pay posted
  });

  it('reads an Ashby job from its board, by id', async () => {
    const { fetchPage } = fetcher({
      'https://api.ashbyhq.com/posting-api/job-board/Ashby?includeCompensation=true':
        fixture('ashby-board.json'),
    });
    const job = await readJob(
      ref('https://jobs.ashbyhq.com/Ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2'),
      fetchPage,
    );
    expect(job).toMatchObject({
      company: 'Ashby',
      workMode: 'Remote',
      postedAt: new Date('2024-03-04T14:29:08.532+00:00'),
      applyLink: 'https://jobs.ashbyhq.com/Ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application',
      questions: null,
    });
    // Ashby's compensation field; another currency is kept as given.
    expect(job.salary).toEqual({ min: 150000, max: 250000, currency: 'EUR' });
  });

  it("reads a Greenhouse job's pay from its pay field (in cents)", async () => {
    const pay = readFileSync(
      new URL('../postings/fixtures/greenhouse-job-pay.json', import.meta.url),
      'utf8',
    );
    const { id } = JSON.parse(pay) as { id: number };
    const { fetchPage } = fetcher({
      [`https://boards-api.greenhouse.io/v1/boards/figma/jobs/${String(id)}?questions=true&pay_transparency=true`]:
        pay,
    });
    const job = await readJob(
      ref(`https://job-boards.greenhouse.io/figma/jobs/${String(id)}`),
      fetchPage,
    );
    expect(job.salary).toEqual({ min: 165000, max: 190000, currency: 'USD' });
  });

  it("falls back to a pay range in the posting's text", async () => {
    const posting = JSON.parse(fixture('lever-posting.json')) as Record<string, unknown>;
    posting.additionalPlain = 'Salary range: $100,000 - $130,000 a year, plus benefits.';
    const { fetchPage } = fetcher({
      'https://api.lever.co/v0/postings/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd':
        JSON.stringify(posting),
    });
    const job = await readJob(
      ref('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'),
      fetchPage,
    );
    expect(job.salary).toEqual({ min: 100000, max: 130000, currency: 'USD' });
  });

  it('fails clearly for a job that is gone or a board that cannot be read', async () => {
    const { fetchPage } = fetcher({
      'https://api.ashbyhq.com/posting-api/job-board/Ashby?includeCompensation=true':
        fixture('ashby-board.json'),
    });
    await expect(
      readJob(
        ref('https://jobs.ashbyhq.com/Ashby/00000000-0000-4000-8000-000000000000'),
        fetchPage,
      ),
    ).rejects.toBeInstanceOf(JobReadError);
    await expect(
      readJob(ref('https://job-boards.greenhouse.io/acme/jobs/1'), fetchPage),
    ).rejects.toBeInstanceOf(JobReadError);
  });

  it('reads a Workable job from the account list, with its country', async () => {
    const { fetchPage } = fetcher({
      'https://apply.workable.com/api/v1/widget/accounts/huggingface':
        fixture('workable-account.json'),
    });
    expect(
      await readJob(ref('https://apply.workable.com/huggingface/j/19A136F8E2/'), fetchPage),
    ).toMatchObject({
      company: 'Hugging Face',
      role: 'Open-Source Machine Learning Engineer - US Remote',
      workMode: 'Remote',
      country: 'United States',
      postedAt: new Date('2026-05-29'),
      applyLink: 'https://apply.workable.com/j/19A136F8E2/apply',
    });
  });

  it('reads a Jobvite page: title, places and text (no date)', async () => {
    const link = 'https://jobs.jobvite.com/nutanix/job/oFBIAfwi';
    const { fetchPage } = fetcher({ [link]: fixture('jobvite-job.html') });
    const job = await readJob(ref(link), fetchPage);
    expect(job).toMatchObject({
      company: 'Nutanix',
      role: 'Service Providers Sales Systems Engineer',
      postedAt: null,
      applyLink: `${link}/apply`,
    });
    expect(job.location).toMatch(/^Omaha, Nebraska; Minneapolis, Minnesota/);
    expect(job.text.length).toBeGreaterThan(100);
    expect(job.salary).toBeNull(); // no pay posted
  });

  it('reads the other boards through Fill from link, with the day posted', async () => {
    const posting = readFileSync(
      new URL('../postings/fixtures/smartrecruiters-job.json', import.meta.url),
      'utf8',
    );
    const { fetchPage } = fetcher({
      'https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings/744000158320111':
        posting,
    });
    const job = await readJob(
      ref('https://jobs.smartrecruiters.com/smartrecruiters/744000158320111-senior-lead'),
      fetchPage,
    );
    expect(job).toMatchObject({
      role: 'Senior / Lead Engineering Operations Manager',
      postedAt: new Date('2026-10-28T00:00:00Z'),
      postedDayOnly: true,
      workMode: 'Remote',
      questions: null,
    });
    expect(job.location).toMatch(/Poland/);
  });

  it('builds a job from a search result when the page cannot be read', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    const icims = ref('https://careers-acme.icims.com/jobs/4321/sdet/job');
    expect(
      jobFromSearchResult(
        icims,
        { title: 'Senior SDET - Remote | Acme Careers', pageAge: '2 days ago' },
        now,
      ),
    ).toMatchObject({
      company: 'Acme',
      role: 'Senior SDET',
      postedAt: new Date('2026-11-05T12:00:00Z'),
      applyLink: 'https://careers-acme.icims.com/jobs/4321/sdet/job',
    });
    expect(
      jobFromSearchResult(
        icims,
        { title: 'Job Application for QA Lead at Acme', pageAge: null },
        now,
      )?.role,
    ).toBe('QA Lead');
    expect(pageAgeToDate('November 3, 2026', now)?.toISOString().slice(0, 10)).toBe('2026-11-03');
    expect(pageAgeToDate('soon', now)).toBeNull();
  });

  it('names a company from its board slug when the board does not', () => {
    expect(companyFromSlug('acme-corp_labs')).toBe('Acme Corp Labs');
  });
});
