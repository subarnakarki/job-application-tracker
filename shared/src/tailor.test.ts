import { describe, expect, it } from 'vitest';
import {
  acceptTailoring,
  applyEdits,
  findInResume,
  unverifiedIn,
  type TailorAnswer,
  lineEdits,
} from './tailor';

const RESUME = `Pat Example, Senior SDET
- Ran performance and load tests with Artillery against public REST APIs.
- Migrated ~2,500 test scenarios from Cypress to Playwright in 4 months.
- Mentored new SDETs and ran testing workshops.`;

const KEYWORDS = [
  { term: 'test strategy', group: 'hard_skill' as const },
  { term: 'Kubernetes', group: 'tool' as const },
  { term: 'k6', group: 'tool' as const },
  { term: 'coaching', group: 'soft_skill' as const },
];

const answer = (edits: TailorAnswer['edits'], notCovered: TailorAnswer['notCovered'] = []) => ({
  edits,
  notCovered,
});

describe('findInResume: the line the model quoted, as the resume writes it', () => {
  it('finds it whatever the case, spacing, bullet sign or full stop', () => {
    expect(
      findInResume(
        RESUME,
        'ran performance and load tests  with artillery against public REST APIs',
      ),
    ).toBe('Ran performance and load tests with Artillery against public REST APIs.');
  });

  it('refuses a line the resume does not have, or a quote too short to trust', () => {
    expect(findInResume(RESUME, 'Ran load tests with k6 against public REST APIs')).toBeNull();
    expect(findInResume(RESUME, 'Playwright')).toBeNull();
  });
});

describe('unverifiedIn: numbers and names the resume never mentions', () => {
  it('judges joined terms whole, and not a skill the edit sets out to add', () => {
    expect(
      unverifiedIn('Owned CI/CD and A/B tests, including CI/CD across Node.js', RESUME, [
        { term: 'CI/CD', group: 'hard_skill' },
      ]),
    ).toEqual(['A/B', 'Node.js']);
  });

  it('flags a product or company named mid-sentence, not the first word', () => {
    expect(unverifiedIn('Planned releases in Jira with Playwright suites', RESUME, [])).toEqual([
      'Jira',
    ]);
    expect(unverifiedIn('Defined the strategy. Coached new SDETs', RESUME, [])).toEqual([]);
  });

  it('flags new numbers, acronyms and tools, not ones the resume has', () => {
    expect(
      unverifiedIn('Migrated 2500 scenarios, cut runtime 40% on AWS with Playwright', RESUME, []),
    ).toEqual(['40%', 'AWS']);
    expect(
      unverifiedIn('Load tests with Artillery', RESUME, [{ term: 'Kubernetes', group: 'tool' }]),
    ).toEqual(['Kubernetes']);
  });
});

describe('acceptTailoring: the model answer, checked by code', () => {
  it('keeps a real edit with only the keywords it really adds', () => {
    const result = acceptTailoring(
      answer(
        [
          {
            original: 'Ran performance and load tests with Artillery against public REST APIs.',
            suggested:
              'Defined the test strategy and ran performance and load tests with Artillery against public REST APIs.',
            keywordsAdded: ['test strategy', 'k6'],
            why: 'The resume describes running the load tests.',
          },
        ],
        [{ keyword: 'Kubernetes', why: 'No Kubernetes experience in the resume.' }],
      ),
      RESUME,
      KEYWORDS,
    );
    expect(result.edits).toEqual([
      {
        original: 'Ran performance and load tests with Artillery against public REST APIs.',
        suggested:
          'Defined the test strategy and ran performance and load tests with Artillery against public REST APIs.',
        keywordsAdded: ['test strategy'],
        why: 'The resume describes running the load tests.',
        unverified: [],
      },
    ]);
    expect(result.notCovered).toEqual([
      { keyword: 'Kubernetes', why: 'No Kubernetes experience in the resume.' },
    ]);
  });

  it('drops invented lines, unchanged lines and repeats; flags invented facts', () => {
    const result = acceptTailoring(
      answer([
        {
          original: 'Led the Kubernetes platform migration for 40 services.',
          suggested: 'Led the Kubernetes platform migration for 40 services with k6.',
          keywordsAdded: ['k6'],
          why: 'Invented.',
        },
        {
          original: 'Mentored new SDETs and ran testing workshops',
          suggested: 'Mentored new SDETs, and ran testing workshops.',
          keywordsAdded: [],
          why: 'Only punctuation.',
        },
        {
          original: 'Mentored new SDETs and ran testing workshops.',
          suggested: 'Coaching: mentored 12 new SDETs and ran Kubernetes testing workshops.',
          keywordsAdded: ['coaching', 'Kubernetes'],
          why: 'Mentoring is coaching.',
        },
        {
          original: 'Mentored new SDETs and ran testing workshops.',
          suggested: 'A second edit of the same line.',
          keywordsAdded: [],
          why: 'Repeat.',
        },
      ]),
      RESUME,
      KEYWORDS,
    );
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      keywordsAdded: ['Kubernetes', 'coaching'],
      unverified: ['12', 'Kubernetes'],
    });
  });

  it('keeps at most 12 edits', () => {
    const lines = Array.from(
      { length: 15 },
      (_, index) => `Owned regression suite number ${String(index)} end to end`,
    );
    const result = acceptTailoring(
      answer(
        lines.map((line) => ({
          original: line,
          suggested: `${line}, as part of the test strategy`,
          keywordsAdded: ['test strategy'],
          why: 'x',
        })),
      ),
      lines.join('\n'),
      KEYWORDS,
    );
    expect(result.edits).toHaveLength(12);
  });
});

describe('applyEdits', () => {
  it('replaces each chosen line once, leaving the rest of the resume as it was', () => {
    const text = applyEdits(RESUME, [
      { original: 'Mentored new SDETs and ran testing workshops', suggested: 'Coached new SDETs' },
      { original: 'not in the resume', suggested: 'ignored' },
    ]);
    expect(text).toBe(
      RESUME.replace('Mentored new SDETs and ran testing workshops', 'Coached new SDETs'),
    );
  });
});

describe('lineEdits: what changed from the resume, line by line', () => {
  const RESUME =
    'Pat Example\n\nSDET\n- Built Playwright suites.\n- Ran SQL reports.\n- Wrote docs.';

  it('pairs a changed line with its replacement and ignores unchanged and blank lines', () => {
    const edited = RESUME.replace('- Ran SQL reports.', '- Ran SQL reports in CI/CD.');
    expect(lineEdits(RESUME, `${edited}\n\n`)).toEqual([
      { original: '- Ran SQL reports.', replacement: '- Ran SQL reports in CI/CD.' },
    ]);
  });

  it('marks a line only added or only removed', () => {
    expect(lineEdits(RESUME, `${RESUME}\n- Led the guild.`)).toEqual([
      { original: '', replacement: '- Led the guild.' },
    ]);
    expect(lineEdits(RESUME, RESUME.replace('\n- Wrote docs.', ''))).toEqual([
      { original: '- Wrote docs.', replacement: '' },
    ]);
  });

  it('pairs a run of changed lines in order', () => {
    const edited = RESUME.replace('- Built Playwright suites.\n- Ran SQL reports.', '- A.\n- B.');
    expect(lineEdits(RESUME, edited)).toEqual([
      { original: '- Built Playwright suites.', replacement: '- A.' },
      { original: '- Ran SQL reports.', replacement: '- B.' },
    ]);
  });

  it('finds nothing when the text is the resume, whatever the spacing', () => {
    expect(lineEdits(RESUME, RESUME.replace(/\n/g, '\r\n  '))).toEqual([]);
  });
});
