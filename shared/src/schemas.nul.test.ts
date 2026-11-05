import { describe, expect, it } from 'vitest';
import { ApplicationInputSchema, ListQuerySchema } from './schemas';

// Postgres rejects NUL in text: these must be 400s, never 500s (found by the API fuzzer).
describe('NUL characters', () => {
  it('are rejected in a search term', () => {
    expect(ListQuerySchema.safeParse({ q: 'a\u0000b' }).success).toBe(false);
  });
  it('are rejected in notes, while newlines stay allowed', () => {
    const base = { company: 'Acme', role: 'SDET' };
    expect(ApplicationInputSchema.safeParse({ ...base, notes: 'a\u0000b' }).success).toBe(false);
    expect(ApplicationInputSchema.safeParse({ ...base, notes: 'line 1\nline 2' }).success).toBe(
      true,
    );
  });
});
