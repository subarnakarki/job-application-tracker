import { describe, expect, it } from 'vitest';
import { letterParagraphs } from './CoverLetterPage';

describe('letterParagraphs', () => {
  it('splits at blank lines and keeps single line breaks inside a paragraph', () => {
    expect(
      letterParagraphs('Dear Jane,\n\nFirst paragraph.\n \nSincerely,\nPat Example\n'),
    ).toEqual(['Dear Jane,', 'First paragraph.', 'Sincerely,\nPat Example']);
  });

  it('handles Windows line endings and extra blank lines', () => {
    expect(letterParagraphs('A\r\n\r\n\r\nB')).toEqual(['A', 'B']);
  });

  it('is empty for an empty letter', () => {
    expect(letterParagraphs('  \n\n ')).toEqual([]);
  });
});
