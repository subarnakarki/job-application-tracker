/**
 * A posting's legal boilerplate, removed before the text goes to the model: equal-opportunity and
 * accommodation notices, E-Verify, privacy notices and agency disclaimers say nothing about the job
 * and can be a large part of a posting. Sentence by sentence (posting text is one line), and only
 * sentences that are clearly such notices; everything else, "About us" included, is kept.
 */
const BOILERPLATE = [
  /\bequal (employment )?opportunit/i,
  /\baffirmative action\b/i,
  /\bwithout regard to\b/i,
  /\b(race|religion|national origin|sexual orientation|gender identity|veteran status)\b[^.]*\b(protected|regard|basis|law)\b/i,
  /\breasonable accommodations?\b/i,
  /\be-?verify\b/i,
  /\b(applicant|candidate|recruit\w*|job applicant) privacy\b|\bprivacy (notice|policy|statement)\b/i,
  /\b(unsolicited (resumes?|cvs?|candidates)|recruitment agenc|staffing agenc|search firms?)\b/i,
  /\bfair chance\b|\barrest (and|or) conviction records?\b/i,
  /\bpay transparency nondiscrimination\b/i,
];

/** Sentences end at . ! or ? followed by a space and a capital letter or a digit. */
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"“(])/;

export function trimPostingBoilerplate(text: string): string {
  const sentences = text.split(SENTENCE_BREAK);
  const kept = sentences.filter(
    (sentence) => !BOILERPLATE.some((pattern) => pattern.test(sentence)),
  );
  // Never send an empty posting: when everything matched, keep the text as it was.
  return kept.length ? kept.join(' ').trim() : text.trim();
}
