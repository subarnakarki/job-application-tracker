import { describe, expect, it } from 'vitest';
import { fileProblem, missingKeywordsText, searchLinks, toBase64 } from './resume';

describe('resume page helpers', () => {
  it('builds job-board searches with the title encoded', () => {
    expect(searchLinks('QA Engineer (C#/.NET)')).toEqual([
      {
        label: 'LinkedIn',
        href: 'https://www.linkedin.com/jobs/search/?keywords=QA%20Engineer%20(C%23%2F.NET)',
      },
      { label: 'Indeed', href: 'https://www.indeed.com/jobs?q=QA%20Engineer%20(C%23%2F.NET)' },
    ]);
  });

  it('lists only the missing keywords', () => {
    expect(
      missingKeywordsText({
        rank: 1,
        title: 'SDET',
        fit: 'good',
        seniority: 'Senior',
        reason: 'r',
        keywords: [
          { term: 'Playwright', group: 'tool', found: true },
          { term: 'Selenium', group: 'tool', found: false },
          { term: 'ISTQB', group: 'certification', found: false },
        ],
      }),
    ).toBe('Selenium, ISTQB');
  });

  it.each([
    [{ name: 'cv.pdf', size: 1000 }, null],
    [{ name: 'CV.DOCX', size: 1000 }, null],
    [{ name: 'cv.pdf', size: 3 * 1024 * 1024 }, 'The file is over 2 MB. Save a smaller copy.'],
    [{ name: 'cv.doc', size: 1000 }, 'Upload a PDF or a Word (.docx) file.'],
  ])('checks %o before upload', (file, problem) => {
    expect(fileProblem(file)).toBe(problem);
  });

  it('encodes a file as base64, large ones included', async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    expect(await toBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });
});
