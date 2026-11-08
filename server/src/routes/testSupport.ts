import { randomUUID } from 'node:crypto';
import { TimeZoneSchema, UserSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializeSessionCookie } from '../auth/cookies';
import { createSession, type SessionUser } from '../auth/sessions';
import { userClock } from '../auth/userClock';
import { toSessionUser } from '../auth/users';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { ROUTE_NOT_FOUND } from '../http/contractValidation';
import { secretsMatch } from '../test-support/config';
import type { EmailClassifier } from '../import/classify';
import type { GmailClient, GmailMessage } from '../import/gmail';
import { runImport } from '../import/run';
import { EmailVerdictSchema } from '../import/verdict';
import { JobSearchProfileSchema, type ModelDraft } from '@jat/shared';
import type { JobSearchClaude } from '../jobsearch/claude';
import { runJobSearch } from '../jobsearch/run';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { saveProfile } from '../repo/jobSearch';

const TestLoginResponse = z.strictObject({ user: UserSchema, token: z.string() });
const NowResponse = z.strictObject({ now: z.iso.datetime({ offset: true }) });
const CleanupResponse = z.strictObject({ deleted: z.number().int().min(0) });
const SecretHeaders = z.object({ 'x-test-secret': z.string() });

/**
 * Test-only routes. They are registered only when `resolveTestRoutes` allows it
 * (see test-support/config.ts), and every request must carry the secret in
 * `x-test-secret`; without it the answer is a plain 404 so the routes do not
 * even reveal that they exist.
 */

/** A job search for a test user: the setup, the postings found and the answers to draft. */
const JobSearchSeedBody = z.strictObject({
  profile: JobSearchProfileSchema,
  jobs: z
    .array(
      z.strictObject({
        board: z.string().regex(/^[a-z0-9-]{1,50}$/),
        company: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        location: z.string().max(200),
        hoursAgo: z
          .number()
          .min(0)
          .max(24 * 365),
        content: z.string().max(5000),
        questions: z
          .array(
            z.strictObject({
              label: z.string().min(1).max(500),
              required: z.boolean(),
              options: z.array(z.string().max(200)).max(20),
            }),
          )
          .max(30),
        /** The posting keywords the draft returns (for the fit score). */
        keywords: z.array(z.string().min(1).max(100)).max(30).default([]),
      }),
    )
    .max(20),
  /** What the model answers, by question; a question left out needs the candidate. */
  answers: z.record(z.string(), z.string()),
});
const JobSearchSeedResponse = z.strictObject({ runId: z.uuid() });

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const LoginBody = z.strictObject({ timeZone: TimeZoneSchema.optional() });

const ClockBody = z
  .strictObject({
    /** Freeze this user's time at an instant, or null to unfreeze. */
    frozenAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
    /** Shift this user's time (ms) relative to the app clock. */
    offsetMs: z.number().int().min(-TEN_YEARS_MS).max(TEN_YEARS_MS).optional(),
  })
  .refine((body) => body.frozenAt !== undefined || body.offsetMs !== undefined, {
    message: 'Give frozenAt, offsetMs or both',
  });

/** A fake inbox for one import: each email and what Claude would say about it (null = unclassified). */
const ImportBody = z.strictObject({
  emails: z
    .array(
      z.strictObject({
        subject: z.string().max(200),
        from: z.string().max(200),
        hoursAgo: z
          .number()
          .min(0)
          .max(24 * 365),
        // Seeds may leave the posting link out.
        verdict: EmailVerdictSchema.extend({
          postingUrl: z.string().max(2000).nullable().default(null),
        }).nullable(),
      }),
    )
    .max(20),
});
const ImportResponse = z.strictObject({ runId: z.uuid() });

const CleanupBody = z.strictObject({
  olderThanMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30),
});

/** Must be registered BEFORE the request pipeline so an unauthorised caller gets 404, not 401/403. */
export function registerTestSecretGuard(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/test/')) return;
    const provided = request.headers['x-test-secret'];
    if (!secretsMatch(secret, Array.isArray(provided) ? provided[0] : provided)) {
      return reply.code(404).send(ROUTE_NOT_FOUND);
    }
  });
}

export interface TestRouteDeps {
  db: Db | undefined;
  clock: Clock;
}

export function registerTestRoutes(app: FastifyInstance, deps: TestRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };

  // Creates a brand-new synthetic user and signs them in. One per test: no shared state, no reset.
  app.post(
    '/api/test/login',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Test only: a new synthetic user, signed in',
          headers: SecretHeaders,
          body: LoginBody,
          responses: { 200: TestLoginResponse },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const body = parseInput(LoginBody, request.body ?? {});
      const now = deps.clock.now();
      const id = randomUUID();

      const user = await db.transaction(async (tx) => {
        const created = await tx.query<{
          id: string;
          email: string;
          name: string | null;
          picture_url: string | null;
          time_zone: string;
          is_demo: boolean;
        }>(
          `insert into users (email, name, time_zone) values ($1, $2, $3)
         returning id, email, name, picture_url, time_zone, is_demo`,
          [`test-${id}@example.invalid`, 'Test User', body.timeZone ?? 'UTC'],
        );
        const row = created.rows[0];
        if (!row) throw new Error('Test user was not created');
        await tx.query(
          "insert into identities (user_id, provider, subject, created_at) values ($1, 'test', $2, $3)",
          [row.id, `test:${id}`, now],
        );
        return toSessionUser(row);
      });

      const session = await createSession(db, user.id, now);
      void reply.header(
        'set-cookie',
        serializeSessionCookie(
          session.token,
          Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );
      // The token is returned too, so non-browser clients can send it as a Cookie header.
      return { user, token: session.token };
    },
  );

  // Runs a real Gmail import for the test user, with the inbox and Claude's answers given in
  // the body: the results page can then be tested without Google or Anthropic.
  app.post(
    '/api/test/import',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Test only: run a Gmail import from a fake inbox',
          headers: SecretHeaders,
          body: ImportBody,
          responses: { 200: ImportResponse },
        },
      },
    },
    async (request) => {
      const user = requireTestUser(request.auth?.user);
      await assertIsTestUser(requireDb(), user.id);
      const body = parseInput(ImportBody, request.body);
      const now = request.clock.now();
      const messages = body.emails.map((email, index): GmailMessage => ({
        id: `test-${randomUUID()}-${index}`,
        from: email.from,
        subject: email.subject,
        date: new Date(now.getTime() - email.hoursAgo * 60 * 60 * 1000),
        body: '',
      }));
      const byId = new Map(messages.map((message, index) => [message.id, body.emails[index]]));
      const gmail: GmailClient = {
        listMessageIds: () => Promise.resolve(messages.map((message) => message.id)),
        getMessage: (_token, id) => {
          const message = messages.find((candidate) => candidate.id === id);
          return message ? Promise.resolve(message) : Promise.reject(new Error('unknown'));
        },
      };
      const classifier: EmailClassifier = {
        classify: (message) => {
          const verdict = byId.get(message.id)?.verdict ?? null;
          return Promise.resolve(
            verdict ? { kind: 'verdict', verdict } : { kind: 'unclassified', reason: 'Declined' },
          );
        },
      };
      const runId = await runImport(
        { db: requireDb(), gmail, classifier, clock: request.clock },
        { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone },
        'test-token',
      );
      return { runId };
    },
  );

  // Saves the job search setup and runs a real search for the test user, with the postings the
  // search "finds" and Claude's answers given in the body: no web search, board or model is called.
  app.post(
    '/api/test/job-search',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Test only: run a job search from given postings and answers',
          headers: SecretHeaders,
          body: JobSearchSeedBody,
          responses: { 200: JobSearchSeedResponse },
        },
      },
    },
    async (request) => {
      const user = requireTestUser(request.auth?.user);
      const db = requireDb();
      await assertIsTestUser(db, user.id);
      const body = parseInput(JobSearchSeedBody, request.body);
      const now = request.clock.now();
      await saveProfile(db, user.id, body.profile, now);

      const pages = new Map(
        body.jobs.map((job, index) => {
          const id = 900000 + index;
          const api = `https://boards-api.greenhouse.io/v1/boards/${job.board}/jobs/${String(id)}?questions=true&pay_transparency=true`;
          const posting = {
            id,
            title: job.title,
            company_name: job.company,
            location: { name: job.location },
            first_published: new Date(now.getTime() - job.hoursAgo * 60 * 60 * 1000).toISOString(),
            content: job.content,
            absolute_url: `https://job-boards.greenhouse.io/${job.board}/jobs/${String(id)}`,
            questions: job.questions.map((question) => ({
              label: question.label,
              required: question.required,
              fields: [
                {
                  name: 'q',
                  type: question.options.length ? 'multi_value_single_select' : 'input_text',
                  values: question.options.map((label, value) => ({ label, value })),
                },
              ],
            })),
          };
          return [api, { link: posting.absolute_url, text: JSON.stringify(posting) }] as const;
        }),
      );
      const fetchPage: PageFetcher = (url) => {
        const page = pages.get(url);
        return page
          ? Promise.resolve({ url, contentType: 'application/json', text: page.text })
          : Promise.reject(new FetchError('network', 'test pages only'));
      };
      const claude: JobSearchClaude = {
        search: () =>
          Promise.resolve({ links: [...pages.values()].map((page) => page.link), searches: 1 }),
        draft: (draftRequest): Promise<ModelDraft> =>
          Promise.resolve({
            answers: draftRequest.questions.map((question) => {
              const answer = body.answers[question.label];
              return {
                question: question.label,
                answer: answer ?? '',
                needsCandidate: answer === undefined,
              };
            }),
            coverLetter: `Dear ${draftRequest.company} team, I would love to join as ${draftRequest.role}.`,
            whyInterested: 'The work matches my experience.',
            keywords: (
              body.jobs.find(
                (job) => job.company === draftRequest.company && job.title === draftRequest.role,
              )?.keywords ?? []
            ).map((term) => ({ term, group: 'hard_skill' as const })),
          }),
      };
      const result = await runJobSearch(
        { db, clock: request.clock, claude, fetchPage, fetchBoard: fetchPage },
        { userId: user.id, timeZone: user.timeZone },
        body.profile,
        'manual',
        Date.now() + 60_000,
      );
      if (result.kind !== 'done') throw new ApiError(409, 'run_in_progress', 'A run is going');
      return { runId: result.runId };
    },
  );

  // Freezes or shifts the signed-in test user's own clock. Nobody else's time moves.
  app.post(
    '/api/test/clock',
    {
      config: {
        auth: 'user',
        contract: {
          summary: "Test only: freeze or shift the user's clock",
          errors: { 403: 'Only synthetic test users may change their clock' },
          headers: SecretHeaders,
          body: ClockBody,
          responses: { 200: NowResponse },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const body = parseInput(ClockBody, request.body);
      const user = requireTestUser(request.auth?.user);
      await assertIsTestUser(db, user.id);

      await db.query(
        `insert into test_clocks (user_id, frozen_at, offset_ms) values ($1, $2, $3)
       on conflict (user_id) do update set
         frozen_at = case when $4 then excluded.frozen_at else test_clocks.frozen_at end,
         offset_ms = case when $5 then excluded.offset_ms else test_clocks.offset_ms end`,
        [
          user.id,
          body.frozenAt ? new Date(body.frozenAt) : null,
          body.offsetMs ?? 0,
          body.frozenAt !== undefined,
          body.offsetMs !== undefined,
        ],
      );
      return { now: (await userClock(db, user.id, deps.clock)).now().toISOString() };
    },
  );

  // The time this user's domain logic sees. Lets tests prove clocks are isolated per user.
  app.get(
    '/api/test/now',
    {
      config: {
        auth: 'user',
        contract: {
          summary: "Test only: the user's current time",
          headers: SecretHeaders,
          responses: { 200: NowResponse },
        },
      },
    },
    (request) => ({
      now: request.clock.now().toISOString(),
    }),
  );

  // Housekeeping for long-lived preview databases: removes synthetic users (and, by cascade, all their data).
  app.post(
    '/api/test/cleanup',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Test only: remove old synthetic users',
          headers: SecretHeaders,
          body: CleanupBody,
          responses: { 200: CleanupResponse },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const body = parseInput(CleanupBody, request.body);
      const cutoff = new Date(deps.clock.now().getTime() - body.olderThanMinutes * 60 * 1000);

      const result = await db.query(
        `delete from users u
        where exists (select 1 from identities i
                       where i.user_id = u.id and i.provider = 'test' and i.created_at < $1)`,
        [cutoff],
      );
      return { deleted: result.rowCount };
    },
  );
}

function requireTestUser(user: SessionUser | undefined): SessionUser {
  if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
  return user;
}

/** The clock routes may only touch synthetic users, never a real or demo account. */
async function assertIsTestUser(db: Db, userId: string): Promise<void> {
  const result = await db.query(
    "select 1 from identities where user_id = $1 and provider = 'test'",
    [userId],
  );
  if (result.rowCount === 0)
    throw new ApiError(403, 'forbidden', 'Only test users may change their clock');
}
