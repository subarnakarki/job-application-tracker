import { readFileSync } from 'node:fs';
import { jobRefOf, type JobRef } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { companyFromSlug, JobReadError, readJob } from './readJob';

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

  it('names a company from its board slug when the board does not', () => {
    expect(companyFromSlug('acme-corp_labs')).toBe('Acme Corp Labs');
  });
});
