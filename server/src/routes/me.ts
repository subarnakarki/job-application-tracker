import { UserSettingsPatchSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import { updateTimeZone } from '../auth/users';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';

export function registerMeRoutes(app: FastifyInstance, db: Db | undefined): void {
  app.get('/api/me', { config: { auth: 'user' } }, (request) => {
    // `auth` is always set on a `user` route: the pipeline answered 401 otherwise.
    return { user: request.auth?.user };
  });

  app.patch('/api/me', { config: { auth: 'user' } }, async (request) => {
    const patch = parseInput(UserSettingsPatchSchema, request.body);
    if (!db || !request.auth)
      throw new ApiError(503, 'unavailable', 'The service is not available');

    const user = await updateTimeZone(db, request.auth.user.id, patch.timeZone);
    if (!user) throw new ApiError(404, 'not_found', 'User not found');
    return { user };
  });
}
