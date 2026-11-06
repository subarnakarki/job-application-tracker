import {
  ImportItemSchema,
  ImportRunDetailSchema,
  ImportRunListSchema,
  ImportStatusSchema,
  type ImportItem as ImportItemView,
} from '@jat/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pkceChallenge, randomToken } from '../auth/google';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError } from '../http/errors';
import { applyItem, dismissItem, undoItem, type ActionResult } from '../import/actions';
import { ClassifierUnavailableError, type EmailClassifier } from '../import/classify';
import { GmailError, type GmailClient } from '../import/gmail';
import {
  GmailAuthError,
  readImportCookie,
  serializeClearedImportCookie,
  serializeImportCookie,
  type GmailAuthorizer,
} from '../import/gmailAuth';
import { ImportAlreadyRunningError, runImport, type ImportDeps } from '../import/run';
import type { Owner } from '../repo/applications';
import {
  getRun,
  hasRunningImport,
  listRuns,
  type ImportItem,
  type ImportRun,
} from '../repo/imports';
import { origin, sameToken } from './google';

export const GMAIL_CALLBACK_PATH = '/api/import/gmail/callback';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });
const CallbackQuery = z.object({
  code: z.string().max(4000).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
  scope: z.string().max(2000).optional(),
});

/** `GMAIL_IMPORT_USER_IDS`: comma-separated user ids that may import (the owner only). */
export function gmailImportUserIds(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env['GMAIL_IMPORT_USER_IDS'] ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
}

export interface ImportRouteDeps {
  db: Db | undefined;
  clock: Clock;
  env: Record<string, string | undefined>;
  authorizer: GmailAuthorizer | null;
  gmail: GmailClient;
  classifier: EmailClassifier | null;
  /** Reading the job postings of the applications an import creates (see runImport). */
  postings?: ImportDeps['postings'];
}

export function presentImportItem(item: ImportItem): ImportItemView {
  return {
    id: item.id,
    emailFrom: item.emailFrom,
    emailSubject: item.emailSubject,
    emailDate: item.emailDate?.toISOString() ?? null,
    verdictKind: item.verdictKind,
    confidence: item.confidence,
    company: item.company,
    role: item.role,
    summary: item.summary,
    reason: item.reason,
    // 'pending' items are never returned (getRun skips them; actions finish them).
    outcome: item.outcome === 'pending' ? 'needs_review' : item.outcome,
    proposedStatus: item.proposedStatus,
    applicationId: item.applicationId,
    fromStatus: item.fromStatus,
    toStatus: item.toStatus,
  };
}

export function presentImportRun(run: ImportRun) {
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    emailsScanned: run.emailsScanned,
    status: run.status,
  };
}

export function registerImportRoutes(app: FastifyInstance, deps: ImportRouteDeps): void {
  const failTo = (reason: string) => `/account?import=${reason}`;
  const notFound = () => new ApiError(404, 'not_found', 'Not found');

  /** True when Gmail import is configured and this user is on the allowlist. */
  const available = (request: FastifyRequest): boolean => {
    const user = request.auth?.user;
    return Boolean(
      user &&
      !user.isDemo &&
      gmailImportUserIds(deps.env).has(user.id.toLowerCase()) &&
      deps.db &&
      deps.authorizer &&
      deps.classifier,
    );
  };

  const ownerOf = (request: FastifyRequest): Owner => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone };
  };

  /**
   * Starting an import: everyone not allowed gets the same 404 as an unknown route, so the
   * feature is invisible. Results and Undo only need the run to be yours (only allowed users
   * ever have runs), so undoing still works if the feature is switched off later.
   */
  const importerOf = (request: FastifyRequest): Owner => {
    if (!available(request)) throw notFound();
    return ownerOf(request);
  };

  const idOf = (request: FastifyRequest): string => {
    const { id } = request.params as { id?: string };
    if (!id || !UUID.test(id)) throw notFound();
    return id.toLowerCase();
  };

  const db = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };

  app.get(
    '/api/import/status',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Whether this user can import from Gmail',
          responses: { 200: ImportStatusSchema },
        },
      },
    },
    (request) => ({ available: available(request) }),
  );

  app.get(
    '/api/import/gmail/start',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Start a Gmail import (redirects to Google for read-only Gmail access)',
          errors: { 404: 'Gmail import is not available to this user' },
          responses: { 302: null },
        },
      },
    },
    async (request, reply) => {
      const owner = importerOf(request);
      const authorizer = deps.authorizer;
      const user = request.auth?.user;
      if (!authorizer || !user) throw notFound();
      // Already importing (another tab, a double click): do not send them to Google again.
      if (await hasRunningImport(db(), owner.userId, deps.clock.now()))
        return reply.redirect(failTo('import_running'), 302);
      const pending = { state: randomToken(), verifier: randomToken(), userId: owner.userId };
      void reply.header('set-cookie', serializeImportCookie(pending));
      return reply.redirect(
        authorizer.authorizationUrl({
          state: pending.state,
          codeChallenge: pkceChallenge(pending.verifier),
          redirectUri: `${origin(request, deps.env)}${GMAIL_CALLBACK_PATH}`,
          loginHint: user.email,
        }),
        302,
      );
    },
  );

  // Finishes the Google consent, runs the import, and lands on its results page. Failures go
  // back to the Account page with a reason code; the details go to the log only.
  app.get(
    GMAIL_CALLBACK_PATH,
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Finish Gmail access, run the import (redirects to its results)',
          errors: { 404: 'Gmail import is not available to this user' },
          query: CallbackQuery,
          responses: { 302: null },
        },
      },
    },
    async (request, reply) => {
      const pending = readImportCookie(request.headers.cookie);
      void reply.header('set-cookie', serializeClearedImportCookie());
      const owner = importerOf(request);
      const { authorizer, classifier } = deps;
      if (!authorizer || !classifier) throw notFound();
      const query = CallbackQuery.safeParse(request.query);
      const params = query.success ? query.data : {};

      if (params.error) return reply.redirect(failTo('gmail_cancelled'), 302);
      if (
        !pending ||
        !params.code ||
        !params.state ||
        !sameToken(params.state, pending.state) ||
        pending.userId !== owner.userId
      ) {
        request.log.warn('Gmail callback without a matching import started by this user');
        return reply.redirect(failTo('gmail_expired'), 302);
      }

      try {
        const accessToken = await authorizer.exchangeCode(
          params.code,
          pending.verifier,
          `${origin(request, deps.env)}${GMAIL_CALLBACK_PATH}`,
        );
        const runId = await runImport(
          {
            db: db(),
            gmail: deps.gmail,
            classifier,
            clock: deps.clock,
            ...(deps.postings ? { postings: deps.postings } : {}),
          },
          owner,
          accessToken,
        );
        return await reply.redirect(`/import/${runId}`, 302);
      } catch (error) {
        if (error instanceof ImportAlreadyRunningError) {
          request.log.warn('Gmail import refused: one is already running for this user');
          return reply.redirect(failTo('import_running'), 302);
        }
        if (error instanceof GmailAuthError) {
          request.log.warn({ reason: error.message }, 'Gmail access refused');
          return reply.redirect(failTo(error.reason), 302);
        }
        if (error instanceof GmailError) {
          request.log.warn({ reason: error.message }, 'Gmail request failed');
          return reply.redirect(failTo('gmail_failed'), 302);
        }
        if (error instanceof ClassifierUnavailableError) {
          request.log.error({ reason: error.message }, 'Classifier unavailable');
          return reply.redirect(failTo('classifier_unavailable'), 302);
        }
        throw error;
      }
    },
  );

  // Anyone signed in may list their own runs (an empty list for everyone not on the allowlist).
  app.get(
    '/api/import/runs',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Recent Gmail imports, newest first, with counts per outcome',
          responses: { 200: ImportRunListSchema },
        },
      },
    },
    async (request) => {
      const owner = ownerOf(request);
      const runs = await listRuns(db(), owner.userId);
      return {
        items: runs.map((run) => ({
          ...presentImportRun(run),
          changed: run.changed,
          needsReview: run.needsReview,
          skipped: run.skipped,
        })),
      };
    },
  );

  app.get(
    '/api/import/runs/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'One Gmail import and what each email led to',
          errors: { 404: 'No such import (or not yours)' },
          params: IdParams,
          responses: { 200: ImportRunDetailSchema },
        },
      },
    },
    async (request) => {
      const owner = ownerOf(request);
      const found = await getRun(db(), owner.userId, idOf(request));
      if (!found) throw notFound();
      return {
        run: presentImportRun(found.run),
        items: found.items.map(presentImportItem),
      };
    },
  );

  const itemAction = (
    path: string,
    summary: string,
    act: (db: Db, owner: Owner, id: string, now: Date) => Promise<ActionResult>,
  ) =>
    app.post(
      path,
      {
        config: {
          auth: 'user',
          contract: {
            summary,
            errors: {
              404: 'No such import item (or not yours)',
              409: 'Not possible for this item now; the message says why',
            },
            params: IdParams,
            responses: { 200: ImportItemSchema },
          },
        },
      },
      async (request) => {
        const owner = ownerOf(request);
        const result = await act(db(), owner, idOf(request), request.clock.now());
        if (result.kind === 'not_found') throw notFound();
        if (result.kind === 'conflict') throw new ApiError(409, 'import_conflict', result.reason);
        return presentImportItem(result.item);
      },
    );

  itemAction('/api/import/items/:id/undo', 'Undo what the import did for this email', undoItem);
  itemAction('/api/import/items/:id/apply', "Make a review item's proposed change", applyItem);
  itemAction('/api/import/items/:id/dismiss', 'Dismiss a review item', (dbx, owner, id) =>
    dismissItem(dbx, owner, id),
  );
}
