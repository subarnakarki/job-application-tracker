import { fileURLToPath } from 'node:url';
import type { ResumeAnalysis } from '@jat/shared';
import { expect, test } from '../fixtures';
import { ResumePage } from '../pages/ResumePage';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../server/src/resume/fixtures/${name}`, import.meta.url));

/** What the server would answer. The analysis itself is covered by API and unit tests. */
const ANALYSIS: ResumeAnalysis = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  fileName: 'resume.pdf',
  model: 'claude-opus-5-5',
  createdAt: '2026-11-05T12:00:00.000Z',
  summary: 'A senior SDET with eight years of Playwright and TypeScript automation.',
  gaps: ['Add numbers to the Northwind role.'],
  warnings: [],
  titles: Array.from({ length: 20 }, (_, index) => ({
    rank: index + 1,
    title: index === 0 ? 'Senior SDET' : `Test Title ${String(index + 1)}`,
    fit: index < 5 ? ('strong' as const) : ('good' as const),
    seniority: 'Senior' as const,
    reason: 'Eight years of test automation at Acme Payments.',
    keywords: [
      { term: 'Playwright', group: 'tool' as const, found: true },
      { term: 'ISTQB', group: 'certification' as const, found: false },
    ],
  })),
};

test('upload a resume, see 20 titles with found and missing keywords, track one', async ({
  page,
}) => {
  // The e2e server has no Anthropic key, so analysis is switched on in the browser's view only.
  await page.route('**/api/resume', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: { ...body, analysisAvailable: true } });
  });
  await page.route('**/api/resume/analyses', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: ANALYSIS })
      : route.fallback(),
  );
  const resume = new ResumePage(page);
  await resume.goto();

  // The upload is real: the server reads the PDF and stores it.
  await resume.fileInput.setInputFiles(fixture('resume.pdf'));
  await expect(page.getByText(/^resume\.pdf · PDF · [\d,]+ characters/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute(
    'href',
    '/api/resume/file',
  );

  await resume.analyse.click();
  await expect(resume.results).toHaveText('Your top 20 titles');
  await expect(resume.titles).toHaveCount(20);

  const first = resume.card('Senior SDET');
  await expect(first.getByText('Strong fit')).toBeVisible();
  await expect(first.getByText('Keywords: 1 of 2 in your resume')).toBeVisible();
  const keywords = first.getByRole('list', { name: 'Keywords for Senior SDET' });
  await expect(keywords.getByRole('listitem')).toHaveText([
    '✓Playwright (in your resume)',
    '+ISTQB (missing)',
  ]);

  await first.getByRole('link', { name: 'Track this title' }).click();
  await expect(page).toHaveURL('/applications/new?role=Senior%20SDET');
  await expect(page.getByLabel('Role')).toHaveValue('Senior SDET');
});

test('a scanned PDF is refused with a way forward, and pasted text works instead', async ({
  page,
}) => {
  const resume = new ResumePage(page);
  await resume.goto();

  await resume.fileInput.setInputFiles(fixture('scanned.pdf'));
  await expect(page.getByRole('alert')).toContainText('No text was found');

  await page.getByRole('button', { name: 'Paste text instead' }).click();
  await page
    .getByLabel('Resume text')
    .fill('Pat Example. Senior SDET with Playwright, TypeScript and CI/CD experience. '.repeat(4));
  await page.getByRole('button', { name: 'Save text' }).click();
  await expect(page.getByText(/^Pasted text · Pasted text · [\d,]+ characters/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download' })).toHaveCount(0);
});
