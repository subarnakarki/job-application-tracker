import {
  DataExportSchema,
  localDateIn,
  UserEnvelopeSchema,
  UserSettingsPatchSchema,
} from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializeClearedSessionCookie } from '../auth/cookies';
import { updateTimeZone } from '../auth/users';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { deleteUser, listAllWithHistory } from '../repo/applications';
import { presentDetail } from '../repo/present';

/** Deleting an account cannot be undone, so the request must say so explicitly. */
export const ACCOUNT_DELETION_CONFIRMATION = 'delete my account';
const DeleteAccountBody = z.strictObject({ confirm: z.literal(ACCOUNT_DELETION_CONFIRMATION) });

export function registerMeRoutes(app: FastifyInstance, db: Db | undefined): void {
  app.get(
    '/api/me',
    {
      config: {
        auth: 'user',
        contract: { summary: 'The signed-in user', responses: { 200: UserEnvelopeSchema } },
      },
    },
    (request) => {
      // `auth` is always set on a `user` route: the pipeline answered 401 otherwise.
      return { user: request.auth?.user };
    },
  );

  app.patch(
    '/api/me',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Change settings (time zone)',
          body: UserSettingsPatchSchema,
          responses: { 200: UserEnvelopeSchema },
        },
      },
    },
    async (request) => {
      const patch = parseInput(UserSettingsPatchSchema, request.body);
      if (!db || !request.auth)
        throw new ApiError(503, 'unavailable', 'The service is not available');

      const user = await updateTimeZone(db, request.auth.user.id, patch.timeZone);
      if (!user) throw new ApiError(404, 'not_found', 'User not found');
      return { user };
    },
  );

  // Everything the app holds about you, as one JSON file.
  app.get(
    '/api/me/export',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Download everything about the user as JSON',
          errors: { 403: 'Not available to the demo account' },
          responses: { 200: DataExportSchema },
        },
      },
    },
    async (request, reply) => {
      const user = request.auth?.user;
      if (!db || !user) throw new ApiError(503, 'unavailable', 'The service is not available');
      if (user.isDemo)
        throw new ApiError(403, 'demo_restricted', 'The shared demo account cannot be exported');

      const now = request.clock.now();
      const applications = await listAllWithHistory(db, user.id);
      void reply.header(
        'content-disposition',
        `attachment; filename="job-applications-${localDateIn(now, user.timeZone)}.json"`,
      );
      return {
        exportedAt: now.toISOString(),
        user,
        applications: applications.map((entry) =>
          presentDetail(entry, { now, timeZone: user.timeZone }),
        ),
      };
    },
  );

  // Deletes the account and, by cascade, every session, application and history row.
  app.delete(
    '/api/me',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete the account and all its data',
          errors: { 403: 'Not available to the demo account' },
          body: DeleteAccountBody,
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const user = request.auth?.user;
      if (!db || !user) throw new ApiError(503, 'unavailable', 'The service is not available');
      parseInput(DeleteAccountBody, request.body);
      if (user.isDemo)
        throw new ApiError(403, 'demo_restricted', 'The shared demo account cannot be deleted');

      await deleteUser(db, user.id);
      void reply.header('set-cookie', serializeClearedSessionCookie());
      return reply.code(204).send();
    },
  );
}
