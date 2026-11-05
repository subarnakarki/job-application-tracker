import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { containsPattern, MAX_SEARCH_TERMS, searchTerms } from './search';

describe('searchTerms', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['   ', []],
    ['acme', ['acme']],
    ['  Acme   SDET  ', ['acme', 'sdet']],
    ['acme ACME Acme', ['acme']],
    ['acme\tsdet\nlead', ['acme', 'sdet', 'lead']],
    ['Zürich café', ['zürich', 'café']],
  ])('%j -> %j', (query, expected) => {
    expect(searchTerms(query)).toEqual(expected);
  });

  it(`keeps at most ${MAX_SEARCH_TERMS} distinct words`, () => {
    const query = Array.from({ length: 20 }, (_, index) => `w${index}`).join(' ');

    expect(searchTerms(query)).toEqual(
      Array.from({ length: MAX_SEARCH_TERMS }, (_, index) => `w${index}`),
    );
  });

  it('never returns an empty or whitespace term (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (query) => {
        for (const term of searchTerms(query)) expect(term.trim()).toBe(term);
        for (const term of searchTerms(query)) expect(term).not.toBe('');
        expect(searchTerms(query).length).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
      }),
    );
  });
});

describe('containsPattern', () => {
  it.each([
    ['acme', '%acme%'],
    ['50%', '%50\\%%'],
    ['a_b', '%a\\_b%'],
    ['back\\slash', '%back\\\\slash%'],
    ['%_\\', '%\\%\\_\\\\%'],
  ])('%j -> %j', (term, expected) => {
    expect(containsPattern(term)).toBe(expected);
  });

  it('leaves no unescaped wildcard inside the term (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (term) => {
        const inner = containsPattern(term).slice(1, -1);
        // Every %, _ and \ in the inner part is preceded by an escaping backslash.
        expect(inner.replace(/\\[\\%_]/g, '')).not.toMatch(/[\\%_]/);
      }),
    );
  });
});
