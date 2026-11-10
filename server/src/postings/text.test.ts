import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from './fetchPage';
import { PreviewError } from './preview';
import {
  jobPostingDescription,
  proseInJson,
  readPostingText,
  textOfBody,
  visibleText,
} from './text';

const PROSE = 'You will build Playwright suites in TypeScript and own CI/CD quality gates. '.repeat(
  4,
);

/** A fetcher that answers from a map of URL -> body, and fails like a dead site otherwise. */
function fetcher(pages: Record<string, string>): { fetchPage: PageFetcher; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: (url) => {
      asked.push(url);
      const text = pages[url];
      return text === undefined
        ? Promise.reject(new FetchError('http_status', '404'))
        : Promise.resolve({ url, contentType: 'text/html', text });
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PreviewError) return error.code;
    throw error;
  }
  throw new Error('expected a PreviewError');
}

describe('posting text', () => {
  it("reads Greenhouse's escaped HTML content", () => {
    const body = JSON.stringify({
      id: 1,
      title: 'SDET',
      content: '&lt;p&gt;You will &lt;strong&gt;build&lt;/strong&gt; Playwright suites.&lt;/p&gt;',
    });
    expect(textOfBody(body)).toBe('You will build Playwright suites.');
  });

  it("reads Lever's description and requirement lists", () => {
    const body = JSON.stringify({
      text: 'SDET',
      descriptionPlain: 'About the team.',
      lists: [{ text: 'Requirements', content: '<li>Playwright</li><li>TypeScript</li>' }],
    });
    expect(textOfBody(body)).toBe('About the team.\nPlaywright TypeScript');
  });

  it('never takes the text of other jobs from a whole board', () => {
    expect(
      proseInJson({
        jobs: [
          { id: 'a', title: 'One', descriptionPlain: 'first job' },
          { id: 'b', title: 'Two', descriptionPlain: 'second job' },
        ],
      }),
    ).toEqual([]);
  });

  it('reads the JobPosting description on a page, including inside @graph', () => {
    const html = `<html><script type="application/ld+json">${JSON.stringify({
      '@graph': [{ '@type': 'Organization' }, { '@type': 'JobPosting', description: '<p>Hi</p>' }],
    })}</script><body>other</body></html>`;
    expect(jobPostingDescription(html)).toBe('Hi');
  });

  it('falls back to the visible text, without scripts, styles or navigation', () => {
    const html =
      '<nav>Menu</nav><script>evil()</script><style>p{}</style><main><h1>SDET</h1><p>Build &amp; test</p></main>';
    expect(visibleText(html)).toBe('SDET Build & test');
  });

  it('reads a board link through its API', async () => {
    const api = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/42?pay_transparency=true';
    const { fetchPage, asked } = fetcher({ [api]: JSON.stringify({ content: PROSE }) });

    expect(await readPostingText('https://job-boards.greenhouse.io/acme/jobs/42', fetchPage)).toBe(
      PROSE.trim(),
    );
    expect(asked).toEqual([api]);
  });

  it('never takes another job’s text from a board’s whole list (Breezy, Recruitee)', async () => {
    const other = 'Senior SRE: you will run Kubernetes clusters and on-call rotations. '.repeat(4);
    const breezyLink = 'https://acme.breezy.hr/p/abc123-qa-engineer';
    const recruiteeLink = 'https://acme.recruitee.com/o/qa-engineer';
    const { fetchPage, asked } = fetcher({
      'https://acme.breezy.hr/json': JSON.stringify([
        { id: 'abc123', name: 'QA Engineer', description: PROSE },
        { id: 'def456', name: 'SRE', description: other },
      ]),
      [breezyLink]: `<main><p>${PROSE}</p></main>`,
      'https://acme.recruitee.com/api/offers/': JSON.stringify({
        offers: [
          { id: 1, slug: 'qa-engineer', title: 'QA Engineer', description: PROSE },
          { id: 2, slug: 'sre', title: 'SRE', description: other },
        ],
      }),
      [recruiteeLink]: `<main><p>${PROSE}</p></main>`,
    });

    expect(await readPostingText(breezyLink, fetchPage)).toBe(PROSE.trim());
    expect(await readPostingText(recruiteeLink, fetchPage)).toBe(PROSE.trim());
    expect(asked).toContain(breezyLink);
  });

  it('Workable and Zoho: the text from the job’s own API, never the list or the scripted page', async () => {
    const saved = (name: string) =>
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const zohoList =
      'https://quoris.zohorecruit.com/recruit/v2/public/Job_Openings?pagename=Careers&source=CareerSite';
    const { fetchPage, asked } = fetcher({
      'https://apply.workable.com/api/v1/accounts/huggingface/jobs/81B46579FE':
        saved('workable-job.json'),
      [zohoList]: saved('zoho-job-list.json'),
    });

    const workable = await readPostingText(
      'https://apply.workable.com/huggingface/j/81B46579FE/',
      fetchPage,
    );
    expect(workable).toMatch(/^At Hugging Face, we're on a journey to democratize good AI/);
    expect(workable).toMatch(/cover letter/); // its requirements too

    const zoho = await readPostingText(
      'https://quoris.zohorecruit.com/jobs/Careers/837266000007382093/Healthcare-QA-Testing-Lead',
      fetchPage,
    );
    expect(zoho).toMatch(/^Healthcare QA Testing Lead Start Date: ASAP/);
    expect(zoho).not.toMatch(/Senior Systems Administrator/); // the other listed job

    expect(asked).toEqual([
      'https://apply.workable.com/api/v1/accounts/huggingface/jobs/81B46579FE',
      zohoList,
    ]);
  });

  it('reads a plain careers page', async () => {
    const url = 'https://careers.example.com/jobs/sdet';
    const { fetchPage } = fetcher({ [url]: `<main><p>${PROSE}</p></main>` });
    expect(await readPostingText(url, fetchPage)).toBe(PROSE.trim());
  });

  it('refuses sign-in sites, unreadable links and pages with no posting', async () => {
    const { fetchPage } = fetcher({ 'https://careers.example.com/empty': '<p>Jobs</p>' });
    expect(await failure(readPostingText('https://www.linkedin.com/jobs/view/1', fetchPage))).toBe(
      'unsupported_site',
    );
    expect(await failure(readPostingText('not a url', fetchPage))).toBe('unreadable');
    expect(await failure(readPostingText('https://careers.example.com/empty', fetchPage))).toBe(
      'no_posting_data',
    );
    expect(await failure(readPostingText('https://careers.example.com/gone', fetchPage))).toBe(
      'no_posting_data',
    );
  });
});
