import { describe, expect, it } from 'vitest';
import { resumeBlocks } from './resumeLayout';

describe('resumeBlocks: a resume laid out for printing', () => {
  it('reads the name, headings, bullet lists and plain lines, skipping blank lines', () => {
    const text = [
      '  Pat Example  ',
      'pat@example.com · Boston, MA',
      '',
      'EXPERIENCE',
      'Senior SDET, Acme (2021 to now)',
      '- Built Playwright suites across 12 teams.',
      '• Ran SQL reports in CI/CD.',
      '',
      'Skills:',
      '1. Playwright',
      '2) TypeScript',
      'Education',
      'BSc Computer Science.',
    ].join('\n');
    expect(resumeBlocks(text)).toEqual([
      { kind: 'name', text: 'Pat Example' },
      { kind: 'line', text: 'pat@example.com · Boston, MA' },
      { kind: 'heading', text: 'EXPERIENCE' },
      { kind: 'line', text: 'Senior SDET, Acme (2021 to now)' },
      {
        kind: 'bullets',
        items: ['Built Playwright suites across 12 teams.', 'Ran SQL reports in CI/CD.'],
      },
      { kind: 'heading', text: 'Skills' },
      { kind: 'bullets', items: ['Playwright', 'TypeScript'] },
      { kind: 'heading', text: 'Education' },
      { kind: 'line', text: 'BSc Computer Science.' },
    ]);
  });

  it('keeps sentences, long lines and dashed ranges as plain lines', () => {
    expect(
      resumeBlocks(
        [
          'Pat',
          'Led QA for checkout: 40% fewer escaped bugs in a year of steady work.',
          '2019-2021 Initech',
          'AWS',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'name', text: 'Pat' },
      {
        kind: 'line',
        text: 'Led QA for checkout: 40% fewer escaped bugs in a year of steady work.',
      },
      { kind: 'line', text: '2019-2021 Initech' },
      { kind: 'heading', text: 'AWS' },
    ]);
  });

  it('is empty for empty text', () => {
    expect(resumeBlocks(' \n \n')).toEqual([]);
  });
});
