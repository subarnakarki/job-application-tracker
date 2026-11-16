import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { dbUsageRecorder } from './usage/record';
import { ClaudeLimitError, limitResponse } from './anthropic/limits';
import { systemClock, type Clock } from './clock';
import type { Db } from './db/types';
import { registerContractValidation, ROUTE_NOT_FOUND } from './http/contractValidation';
import { ApiError } from './http/errors';
import { enforceRoutePolicy } from './http/policy';
import { registerRequestPipeline } from './http/pipeline';
import { googleProviderFromEnv, type GoogleProvider } from './auth/google';
import { registerApplicationRoutes } from './routes/applications';
import { registerGoogleRoutes } from './routes/google';
import { createPageFetcher, type PageFetcher } from './postings/fetchPage';

/** Size cap for reading a company's whole job board. */
const BOARD_MAX_BYTES = 10 * 1024 * 1024;
import { registerInterviewRoutes } from './routes/interviews';
import { registerPostingRoutes } from './routes/postings';
import { registerLeadRoutes } from './routes/leads';
import { registerHealthRoutes } from './routes/health';
import { registerImportRoutes } from './routes/import';
import { classifierFromEnv, type EmailClassifier } from './import/classify';
import { gmailRestClient, type GmailClient } from './import/gmail';
import { gmailAuthorizerFromEnv, type GmailAuthorizer } from './import/gmailAuth';
import { registerMeRoutes } from './routes/me';
import { registerResumeRoutes } from './routes/resume';
import { registerJobSearchRoutes } from './routes/jobSearch';
import { registerJobSearchBoardRoutes } from './routes/jobSearchBoards';
import { registerLeadMessageRoutes } from './routes/leadMessages';
import { registerTailoringRoutes } from './routes/tailoring';
import { registerCoverLetterRoutes } from './routes/coverLetters';
import { allowedUserIds } from './jobsearch/access';
import { jobSearchClaudeFromEnv, type JobSearchClaude } from './jobsearch/claude';
import { analyzerFromEnv, type ResumeAnalyzer } from './resume/analyze';
import { registerSessionRoutes } from './routes/session';
import { registerTestRoutes, registerTestSecretGuard } from './routes/testSupport';
import { resolveTestRoutes } from './test-support/config';

export interface AppDeps {
  /** Absent in tests that never touch the database. */
  db?: Db;
  logger?: FastifyServerOptions['logger'];
  /** "Now" for sessions, rate limits and (later) domain rules. Tests pass a controllable one. */
  clock?: Clock;
  env?: Record<string, string | undefined>;
  /** Google sign-in. Defaults to the real provider when GOOGLE_CLIENT_ID/SECRET are set; tests pass a stub. */
  google?: GoogleProvider | null;
  /** Gmail import: read-only Gmail consent, the Gmail API and the Claude classifier. Tests pass stubs. */
  gmailAuthorizer?: GmailAuthorizer | null;
  gmail?: GmailClient;
  classifier?: EmailClassifier | null;
  /** Resume analysis (Claude as a recruiter). Defaults to the real one when ANTHROPIC_API_KEY is set. */
  resumeAnalyzer?: ResumeAnalyzer | null;
  /** Job search: web search and drafting with Claude. Defaults to the real one with a key. */
  jobSearchClaude?: JobSearchClaude | null;
  /** Reads pasted posting links. Defaults to the guarded real fetcher; tests pass a stub. */
  fetchPage?: PageFetcher;
  /** Validate every response against its route contract (tests). */
  validateResponses?: boolean;
}

/**
 * Builds the Fastify app without listening, so tests (and the Vercel entry)
 * can use it directly. Everything the app depends on is injected.
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const clock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;

  // Must come first: it checks every route as it is registered.
  enforceRoutePolicy(app);
  if (deps.validateResponses) registerContractValidation(app);
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(ROUTE_NOT_FOUND));

  // Never leak internals: a 5xx returns a fixed body (details go to the log),
  // while deliberate errors keep their message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Anthropic declined for capacity or money: a 503 the web app can tell apart, never a 500.
    if (error instanceof ClaudeLimitError) {
      const answer = limitResponse(error);
      request.log.warn({ limit: error.kind, retryAfter: error.retryAfterSeconds }, 'claude limit');
      if (answer.retryAfterSeconds !== null)
        void reply.header('retry-after', String(answer.retryAfterSeconds));
      return reply.code(answer.statusCode).send({ error: answer.code, message: answer.message });
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(statusCode).send({ error: error.code, message: error.message });
  });

  // Test-only routes exist only when the environment explicitly allows them (never in production).
  const testRoutes = resolveTestRoutes(env);
  // The secret guard goes first, so a caller without it sees a plain 404 for anything under /api/test/.
  if (testRoutes) registerTestSecretGuard(app, testRoutes.secret);

  // Token counts of every Claude call, to measure cost per kind of call.
  const recordUsage = dbUsageRecorder(deps.db, (error) => {
    app.log.warn({ err: error }, 'model usage not recorded');
  });
  registerRequestPipeline(app, { db: deps.db, clock, perUserClocks: testRoutes !== null });
  registerHealthRoutes(app, deps.db);
  registerSessionRoutes(app, { db: deps.db, clock, env });
  const google = deps.google === undefined ? googleProviderFromEnv(env) : deps.google;
  registerGoogleRoutes(app, { db: deps.db, clock, env, google });
  registerMeRoutes(app, deps.db);
  const fetchPage = deps.fetchPage ?? createPageFetcher();
  const fetchBoard = deps.fetchPage ?? createPageFetcher({ maxBytes: BOARD_MAX_BYTES });
  registerApplicationRoutes(app, { db: deps.db, clock, fetchBoard });
  registerLeadRoutes(app, { db: deps.db, clock });
  registerInterviewRoutes(app, { db: deps.db, clock });
  registerPostingRoutes(app, { db: deps.db, clock, fetchPage });
  registerImportRoutes(app, {
    db: deps.db,
    clock,
    env,
    authorizer:
      deps.gmailAuthorizer === undefined ? gmailAuthorizerFromEnv(env) : deps.gmailAuthorizer,
    gmail: deps.gmail ?? gmailRestClient,
    classifier:
      deps.classifier === undefined ? classifierFromEnv(env, recordUsage) : deps.classifier,
    postings: {
      fetchPage,
      // A company's whole job board (every open job) can be several MB.
      fetchBoard,
    },
  });
  registerResumeRoutes(app, {
    db: deps.db,
    clock,
    analyzer:
      deps.resumeAnalyzer === undefined ? analyzerFromEnv(env, recordUsage) : deps.resumeAnalyzer,
    fetchPage,
    // The owner is whoever the job search is open to.
    isOwner: (userId) => allowedUserIds(env).has(userId.toLowerCase()),
  });
  const jobSearchClaude =
    deps.jobSearchClaude === undefined
      ? jobSearchClaudeFromEnv(env, recordUsage)
      : deps.jobSearchClaude;
  registerJobSearchRoutes(app, {
    db: deps.db,
    clock,
    env,
    claude: jobSearchClaude,
    fetchPage,
    fetchBoard,
    openToTestUsers: testRoutes !== null,
  });
  registerJobSearchBoardRoutes(app, {
    db: deps.db,
    clock,
    env,
    claude: jobSearchClaude,
    fetchBoard,
    openToTestUsers: testRoutes !== null,
  });
  registerLeadMessageRoutes(app, {
    db: deps.db,
    clock,
    env,
    claude: jobSearchClaude,
    openToTestUsers: testRoutes !== null,
  });
  registerTailoringRoutes(app, {
    db: deps.db,
    clock,
    env,
    claude: jobSearchClaude,
    fetchPage,
    openToTestUsers: testRoutes !== null,
  });
  registerCoverLetterRoutes(app, {
    db: deps.db,
    clock,
    env,
    claude: jobSearchClaude,
    fetchPage,
    openToTestUsers: testRoutes !== null,
  });
  if (testRoutes) registerTestRoutes(app, { db: deps.db, clock });

  return app;
}
