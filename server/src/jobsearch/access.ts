import { clipToLength, LEAD_MESSAGE_LIMITS } from '@jat/shared';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/types';
import { ApiError } from '../http/errors';
import type { JobSearchClaude } from './claude';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stand-in for test users when there is no key: finds nothing and drafts nothing; tailoring
 * rewords the resume's first line to add the first missing keyword, and invents a number, so e2e
 * tests see a real answer go through the server's checks. A lead message is a fixed, short text.
 */
export const NO_CLAUDE: JobSearchClaude = {
  search: () => Promise.resolve({ links: [], searches: 0 }),
  draft: () => Promise.resolve(null),
  tailor: (request) => {
    const line = request.resumeText
      .split(/\r?\n|(?<=\.)\s+/)
      .map((entry) => entry.trim())
      .find((entry) => entry.split(/\s+/).length >= 3);
    const keyword = request.missing[0];
    return Promise.resolve({
      edits:
        line && keyword
          ? [
              {
                original: line,
                suggested: `${line.replace(/\.$/, '')}, including ${keyword} across 12 teams.`,
                keywordsAdded: [keyword],
                why: "The same work, in the posting's words.",
              },
            ]
          : [],
      notCovered: request.missing
        .slice(1, 2)
        .map((term) => ({ keyword: term, why: `No ${term} experience in the resume.` })),
    });
  },
  tailorPosting: (request) => {
    // The posting's capitalised terms are its keywords; the first one the resume lacks is added to
    // the resume's first line.
    const terms = [
      ...new Set(
        (request.postingText.match(/\b[A-Z][A-Za-z0-9+#./-]{2,}/g) ?? []).map((term) =>
          term.replace(/[./-]+$/, ''),
        ),
      ),
    ].slice(0, 8);
    const resume = request.resumeText.toLowerCase();
    const missing = terms.filter((term) => !resume.includes(term.toLowerCase()));
    const line = request.resumeText
      .split(/\r?\n|(?<=\.)\s+/)
      .map((entry) => entry.trim())
      .find((entry) => entry.split(/\s+/).length >= 3);
    const keyword = missing[0];
    return Promise.resolve({
      keywords: terms.map((term) => ({ term, group: 'tool' as const })),
      edits:
        line && keyword
          ? [
              {
                original: line,
                suggested: `${line.replace(/\.$/, '')}, using ${keyword}.`,
                keywordsAdded: [keyword],
                why: "The same work, in the posting's words.",
              },
            ]
          : [],
      notCovered: missing
        .slice(1, 2)
        .map((term) => ({ keyword: term, why: `No ${term} experience in the resume.` })),
    });
  },
  leadMessage: (request) => {
    const first = request.lead.name.split(/\s+/)[0] ?? request.lead.name;
    const job = `the ${request.role} role at ${request.company}`;
    return Promise.resolve({
      connectionNote: clipToLength(
        `Hi ${first}, I'm interested in ${job} and would value connecting.`,
        LEAD_MESSAGE_LIMITS.connectionNote,
      ),
      message: [
        `Hi ${first},`,
        `I'm interested in ${job}.${request.steer ? ` ${request.steer}` : ''}`,
        'Would you be open to a short chat?',
        'Thank you!',
      ].join('\n\n'),
    });
  },
};

/** Owner-only at first: the users listed in JOB_SEARCH_USER_IDS (comma-separated ids). */
export function allowedUserIds(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env['JOB_SEARCH_USER_IDS'] ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
}

export const notAvailable = () =>
  new ApiError(404, 'not_available', 'The job search is not available for this account');

export interface JobSearchAccessDeps {
  db: Db | undefined;
  env: Record<string, string | undefined>;
  /** Null without an Anthropic key: the features are off. */
  claude: JobSearchClaude | null;
  /** Test routes on (never in production): synthetic test users may use these features. */
  openToTestUsers?: boolean;
}

/**
 * Who may use the job search and the features built on it (tailoring, lead messages): the owner
 * (JOB_SEARCH_USER_IDS) with a key, or a synthetic test user while test routes are on; never the
 * demo account. One place, so every route applies the same rule.
 */
export function jobSearchAccess(deps: JobSearchAccessDeps) {
  const isTestUser = async (userId: string) =>
    deps.openToTestUsers === true &&
    deps.db !== undefined &&
    (
      await deps.db.query("select 1 from identities where user_id = $1 and provider = 'test'", [
        userId,
      ])
    ).rowCount > 0;

  /** The Claude this user's features use, or null when they are not open to them. */
  const claudeFor = async (user: { id: string; isDemo: boolean }) => {
    if (user.isDemo) return null;
    if (deps.claude && allowedUserIds(deps.env).has(user.id.toLowerCase())) return deps.claude;
    return (await isTestUser(user.id)) ? (deps.claude ?? NO_CLAUDE) : null;
  };

  /** The signed-in user, when the features are open to them; 404 otherwise (not theirs). */
  const memberOf = async (request: FastifyRequest) => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    const claude = await claudeFor(user);
    if (!claude) throw notAvailable();
    return { user, claude };
  };

  return { claudeFor, memberOf };
}
