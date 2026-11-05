/** At most this many words are matched; the rest of a very long query is ignored. */
export const MAX_SEARCH_TERMS = 8;

/**
 * The words of a search, lower-cased, de-duplicated, in order. "acme  SDET acme"
 * -> ["acme", "sdet"]. Every word must match somewhere (company, role, contact or
 * notes) for an application to be found.
 */
export function searchTerms(query: string | undefined): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (word && !seen.has(word)) seen.add(word);
    if (seen.size === MAX_SEARCH_TERMS) break;
  }
  return [...seen];
}

/**
 * A LIKE pattern matching `term` anywhere, with the LIKE wildcards in the term
 * taken literally: searching "50%" must not match "500", and "a_b" must not
 * match "axb". Use with `escape '\'`.
 */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
