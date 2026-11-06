import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  acceptAnswer,
  indexText,
  keywordInText,
  keywordTokens,
  RESUME_LIMITS,
  ResumeResultSchema,
  ResumeUploadSchema,
  type ResumeAnswer,
} from './resume';

describe('keywordInText', () => {
  it.each([
    ['exact words, any case', 'Playwright', 'Built suites in playwright and Vitest'],
    ['a phrase', 'test automation', 'Led Test Automation for payments'],
    ['with or without a hyphen', 'front-end', 'Ten years of frontend work'],
    ['with or without spaces', 'frontend', 'front end performance'],
    ['a slash spelled out or not', 'CI/CD', 'Owned the CICD pipeline'],
    ['a hyphen instead of a slash', 'CI/CD', 'ci-cd on GitHub Actions'],
    ['a dot name', 'Node.js', 'APIs in NodeJS'],
    ['an alias', 'JavaScript', 'React, JS and CSS'],
    ['an alias the other way', 'AWS', 'Amazon Web Services (EC2, S3)'],
    ['k8s for Kubernetes', 'Kubernetes', 'deployed to k8s'],
    ['Postgres for PostgreSQL', 'PostgreSQL', 'Postgres 18, pg'],
    ['a plural', 'API', 'Designed REST APIs'],
    ['a singular for a plural term', 'stakeholders', 'every stakeholder'],
    ['-ies plurals', 'technology', 'cloud technologies'],
    ['C++ and C#', 'C++', 'Languages: C++, C#'],
    ['C#', 'C#', 'Languages: C++, C#'],
    ['.NET', '.NET', 'ASP.NET and .NET 8'],
    ['accents ignored', 'résumé writing', 'Resume writing coach'],
    ['& as and', 'R&D', 'Ran R and D'],
    ['A/B testing', 'A/B testing', 'AB testing of the checkout'],
  ])('finds %s', (_label, term, text) => {
    expect(keywordInText(term, text)).toBe(true);
  });

  it.each([
    ['part of a longer word', 'Java', 'JavaScript and TypeScript'],
    ['a prefix', 'Go', 'Google Ads'],
    ['the plain word "go" as Golang', 'Golang', 'ready to go'],
    ['words out of order', 'test automation', 'automation of the test lab'],
    ['words apart', 'machine learning', 'machine shop, learning fast'],
    ['C for C++', 'C', 'C++ only'],
    ['C++ for C', 'C++', 'C and Rust'],
    ['an absent term', 'Selenium', 'Playwright and Cypress'],
    ['an empty term', '  ', 'anything'],
    ['punctuation only', '/-.', 'anything / - .'],
  ])('does not find %s', (_label, term, text) => {
    expect(keywordInText(term, text)).toBe(false);
  });

  it('always finds a term that was copied into the text, whatever surrounds it', () => {
    const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,9}$/);
    fc.assert(
      fc.property(
        fc.array(word, { minLength: 1, maxLength: 4 }),
        fc.string(),
        fc.string(),
        (words, before, after) => {
          const term = words.join(' ');
          expect(keywordInText(term, `${before} ${term} ${after}`)).toBe(true);
        },
      ),
    );
  });

  it('gives the same answer from one index as from separate checks', () => {
    const text = 'Senior SDET: Playwright, TypeScript, k8s, CI/CD';
    const index = indexText(text);
    for (const term of ['Playwright', 'Kubernetes', 'Java', 'CICD', 'Selenium'])
      expect(index.has(term), term).toBe(keywordInText(term, text));
  });

  it('turns text into the words it compares', () => {
    expect(keywordTokens('Node.js, CI/CD & C++ APIs')).toEqual([
      'nodejs',
      'cicd',
      'and',
      'cplusplus',
      'api',
    ]);
  });
});

const keyword = (term: string) => ({ term, group: 'tool' as const });
const title = (name: string, terms: string[] = ['Playwright']) => ({
  title: name,
  fit: 'strong' as const,
  seniority: 'Senior' as const,
  reason: `Fits ${name}`,
  keywords: terms.map(keyword),
});
const answerWith = (count: number, overrides: Partial<ResumeAnswer> = {}): ResumeAnswer => ({
  summary: 'A senior SDET.',
  titles: Array.from({ length: count }, (_, index) => title(`Title ${index + 1}`)),
  gaps: [],
  warnings: [],
  ...overrides,
});

describe('acceptAnswer', () => {
  const resume = 'Built suites in Playwright and TypeScript.';

  it('ranks titles in order and marks each keyword found or missing by code', () => {
    const result = acceptAnswer(
      answerWith(20, {
        titles: [title('QA Engineer', ['Playwright', 'Selenium', 'TS']), ...answerWith(19).titles],
      }),
      resume,
    );

    expect(result).not.toBeNull();
    expect(ResumeResultSchema.parse(result)).toEqual(result);
    expect(result?.titles.map((entry) => entry.rank)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(result?.titles[0]?.keywords).toEqual([
      { term: 'Playwright', group: 'tool', found: true },
      { term: 'Selenium', group: 'tool', found: false },
      { term: 'TS', group: 'tool', found: true },
    ]);
  });

  it('keeps at most 20 titles and 20 keywords, without duplicates', () => {
    const many = Array.from({ length: 30 }, (_, index) => `Skill${index}`);
    const result = acceptAnswer(
      answerWith(25, {
        titles: [
          title('QA Lead', [...many, 'front end', 'Front-End']),
          title('qa lead'),
          ...answerWith(24).titles,
        ],
      }),
      resume,
    );

    expect(result?.titles).toHaveLength(RESUME_LIMITS.titles);
    expect(result?.titles.filter((entry) => entry.title.toLowerCase() === 'qa lead')).toHaveLength(
      1,
    );
    expect(result?.titles[0]?.keywords).toHaveLength(RESUME_LIMITS.keywordsPerTitle);
  });

  it('drops a duplicate keyword spelled differently', () => {
    const result = acceptAnswer(
      answerWith(12, {
        titles: [title('SDET', ['front end', 'Front-End']), ...answerWith(11).titles],
      }),
      resume,
    );
    expect(result?.titles[0]?.keywords.map((entry) => entry.term)).toEqual(['front end']);
  });

  it('refuses an answer with too few titles or no summary', () => {
    expect(acceptAnswer(answerWith(RESUME_LIMITS.minTitles - 1), resume)).toBeNull();
    expect(acceptAnswer(answerWith(20, { summary: '   ' }), resume)).toBeNull();
    expect(acceptAnswer(answerWith(RESUME_LIMITS.minTitles), resume)?.titles).toHaveLength(
      RESUME_LIMITS.minTitles,
    );
  });

  it('skips titles with no name or reason, and clips over-long text', () => {
    const result = acceptAnswer(
      answerWith(12, {
        summary: 'x'.repeat(5000),
        titles: [
          { ...title(''), reason: 'r' },
          { ...title('Empty reason'), reason: ' ' },
          ...answerWith(11).titles,
        ],
        gaps: Array.from({ length: 15 }, () => 'g'.repeat(1000)),
      }),
      resume,
    );
    expect(result?.titles).toHaveLength(11);
    expect(result?.summary).toHaveLength(RESUME_LIMITS.summary);
    expect(result?.gaps).toHaveLength(RESUME_LIMITS.notes);
    expect(result?.gaps[0]).toHaveLength(RESUME_LIMITS.note);
  });
});

describe('ResumeUploadSchema', () => {
  it('takes a base64 file or pasted text', () => {
    expect(
      ResumeUploadSchema.safeParse({ kind: 'file', fileName: 'cv.pdf', dataBase64: 'JVBERi0=' })
        .success,
    ).toBe(true);
    expect(ResumeUploadSchema.safeParse({ kind: 'text', text: 'Pat Doe' }).success).toBe(true);
  });

  it.each([
    ['data that is not base64', { kind: 'file', fileName: 'cv.pdf', dataBase64: 'not base64!' }],
    ['an empty file name', { kind: 'file', fileName: ' ', dataBase64: 'JVBERi0=' }],
    [
      'a file far over the size cap',
      { kind: 'file', fileName: 'cv.pdf', dataBase64: 'A'.repeat(3_000_000) },
    ],
    ['empty text', { kind: 'text', text: '   ' }],
    ['too much text', { kind: 'text', text: 'x'.repeat(RESUME_LIMITS.textChars + 1) }],
    ['an unknown kind', { kind: 'link', url: 'https://example.com' }],
  ])('refuses %s', (_label, body) => {
    expect(ResumeUploadSchema.safeParse(body).success).toBe(false);
  });
});
