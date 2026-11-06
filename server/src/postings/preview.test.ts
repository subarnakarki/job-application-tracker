import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from './fetchPage';
import { cleanText, previewPosting, PreviewError, siteOf } from './preview';

/** A fetcher that serves canned pages, the way the internet would. */
function pages(map: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    const text = map[url];
    return text === undefined
      ? Promise.reject(new FetchError('http_status', '404'))
      : Promise.resolve({ url, contentType: 'text/html', text });
  };
  return Object.assign(fetcher, { asked });
}

const ldPage = (data: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreviewError) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('fill from link: schema.org JobPosting on the page', () => {
  it('reads the title, company and a yearly salary range', async () => {
    const url = 'https://careers.example.com/jobs/42#apply';
    const fetch = pages({
      'https://careers.example.com/jobs/42#apply': ldPage({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Senior SDET &amp; Automation <b>Lead</b>',
        hiringOrganization: { '@type': 'Organization', name: 'Acme &#38; Co' },
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'usd',
          value: {
            '@type': 'QuantitativeValue',
            minValue: 140000,
            maxValue: '175,000',
            unitText: 'YEAR',
          },
        },
      }),
    });
    expect(await previewPosting(url, fetch)).toEqual({
      jobLink: 'https://careers.example.com/jobs/42',
      company: 'Acme & Co',
      role: 'Senior SDET & Automation Lead',
      salaryMin: 140000,
      salaryMax: 175000,
      salaryCurrency: 'USD',
      location: null,
      workMode: null,
      postedOn: null,
    });
  });

  it('finds it inside @graph, skips broken blocks, and ignores hourly pay', async () => {
    const html =
      '<script type="application/ld+json">{ not json</script>' +
      ldPage({
        '@graph': [
          { '@type': 'WebPage' },
          {
            '@type': ['JobPosting'],
            title: 'QA Engineer',
            hiringOrganization: 'Globex',
            baseSalary: {
              currency: 'USD',
              value: { minValue: 40, maxValue: 60, unitText: 'HOUR' },
            },
          },
        ],
      });
    const preview = await previewPosting(
      'https://jobs.example.org/qa',
      pages({ 'https://jobs.example.org/qa': html }),
    );
    expect(preview).toMatchObject({
      company: 'Globex',
      role: 'QA Engineer',
      salaryMin: null,
      salaryCurrency: null,
    });
  });

  it('says so when a page has no job details', async () => {
    const fetch = pages({ 'https://example.com/about': '<html><title>About us</title></html>' });
    expect(await failure(previewPosting('https://example.com/about', fetch))).toBe(
      'no_posting_data',
    );
  });

  it('refuses sign-in sites without fetching them, and reports unreadable pages', async () => {
    const fetch = pages({});
    expect(await failure(previewPosting('https://www.linkedin.com/jobs/view/123', fetch))).toBe(
      'unsupported_site',
    );
    expect(fetch.asked).toEqual([]);
    expect(await failure(previewPosting('https://gone.example.com/job', fetch))).toBe('unreadable');
  });
});

describe('fill from link: job-board APIs', () => {
  it('Greenhouse: reads its public API, since its pages carry no JobPosting data', async () => {
    const fetch = pages({
      'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8638232002?pay_transparency=true':
        JSON.stringify({
          title: 'Senior Backend Engineer',
          company_name: 'GitLab',
          absolute_url: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
        }),
    });
    const preview = await previewPosting(
      'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
      fetch,
    );
    expect(preview).toMatchObject({
      company: 'GitLab',
      role: 'Senior Backend Engineer',
      salaryMin: null,
    });
    expect(fetch.asked).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8638232002?pay_transparency=true',
    ]);
  });

  it('Lever: the page for company and title, the API for a yearly salary', async () => {
    const id = 'ad208490-4052-4f91-a57e-433f2d1e484b';
    const fetch = pages({
      [`https://jobs.lever.co/leverdemo/${id}`]: ldPage({
        '@type': 'JobPosting',
        title: 'Customer Success Manager',
        hiringOrganization: { '@type': 'Organization', name: 'Lever Demo' },
      }),
      [`https://api.lever.co/v0/postings/leverdemo/${id}`]: JSON.stringify({
        text: 'Customer Success Manager',
        salaryRange: { min: 85000, max: 175000, currency: 'USD', interval: 'per-year-salary' },
      }),
    });
    expect(await previewPosting(`https://jobs.lever.co/leverdemo/${id}`, fetch)).toMatchObject({
      company: 'Lever Demo',
      salaryMin: 85000,
      salaryMax: 175000,
      salaryCurrency: 'USD',
    });
  });

  it('Ashby: a single yearly salary is used; several regional tiers are not guessed between', async () => {
    const id = '7458d4e9-da2e-47bd-98cb-adfda43d42b2';
    const page = ldPage({
      '@type': 'JobPosting',
      title: 'Engineering Manager',
      hiringOrganization: { name: 'Ashby' },
    });
    const salary = (min: number, max: number, currencyCode: string) => ({
      compensationType: 'Salary',
      interval: '1 YEAR',
      currencyCode,
      minValue: min,
      maxValue: max,
    });
    const board = (tiers: unknown[]) =>
      JSON.stringify({
        jobs: [{ id, title: 'Engineering Manager', compensation: { compensationTiers: tiers } }],
      });
    const url = `https://jobs.ashbyhq.com/ashby/${id}`;
    const api = 'https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true';

    const one = pages({
      [url]: page,
      [api]: board([
        {
          components: [
            salary(150000, 250000, 'EUR'),
            { compensationType: 'EquityPercentage', interval: 'NONE' },
          ],
        },
      ]),
    });
    expect(await previewPosting(url, one)).toMatchObject({
      salaryMin: 150000,
      salaryMax: 250000,
      salaryCurrency: 'EUR',
    });

    const several = pages({
      [url]: page,
      [api]: board([
        { components: [salary(150000, 250000, 'EUR')] },
        { components: [salary(180000, 260000, 'USD')] },
      ]),
    });
    expect(await previewPosting(url, several)).toMatchObject({ company: 'Ashby', salaryMin: null });
  });

  it('only builds API links from ids that look right', () => {
    expect(siteOf(new URL('https://boards.greenhouse.io/acme/jobs/123'))).toMatchObject({
      kind: 'greenhouse',
    });
    expect(siteOf(new URL('https://boards.greenhouse.io/acme/jobs/123%2F..%2Fsecret'))).toEqual({
      kind: 'page',
    });
    expect(siteOf(new URL('https://jobs.lever.co/acme/not-a-uuid'))).toEqual({ kind: 'page' });
    expect(siteOf(new URL('https://evil.example/boards.greenhouse.io/acme/jobs/1'))).toEqual({
      kind: 'page',
    });
  });
});

describe('cleanText', () => {
  it('decodes entities, drops tags and control characters, and caps the length', () => {
    expect(cleanText(' Lead&nbsp;SDET\n<i>(remote)</i>&#x1F680; ', 200)).toBe(
      'Lead SDET (remote) 🚀',
    );
    expect(cleanText('a'.repeat(300), 200)).toHaveLength(200);
    expect(cleanText(42, 200)).toBeNull();
    expect(cleanText('   ', 200)).toBeNull();
  });
});
