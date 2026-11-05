import type { FastifyInstance } from 'fastify';
import type { RouteContract } from './contract';

/**
 * Every route must say who may call it:
 * - `public`: no session needed (health checks, sign-in, sign-out);
 * - `user`: a valid session is required, otherwise 401.
 *
 * There is no default. A route registered without `config.auth`, or without a
 * `config.contract` declaring what it returns, makes the app fail at startup, so
 * "forgot to protect it" or "forgot to describe it" cannot reach production.
 */
export type AuthMode = 'public' | 'user';

export interface RegisteredRoute {
  method: string;
  /** The route pattern as registered, e.g. `/api/applications/:id`. */
  url: string;
  auth: AuthMode;
  /** State-changing methods are the ones the CSRF guard protects. */
  mutating: boolean;
  contract: RouteContract;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthMode;
    contract?: RouteContract;
  }
  interface FastifyInstance {
    /** Every route registered so far (HEAD and OPTIONS aside). The route-registry tests walk this list. */
    registeredRoutes: RegisteredRoute[];
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Must be called before any route is registered. */
export function enforceRoutePolicy(app: FastifyInstance): void {
  app.decorate('registeredRoutes', [] as RegisteredRoute[]);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const auth = route.config?.auth;
    if (auth !== 'public' && auth !== 'user') {
      throw new Error(
        `Route ${methods.join(',')} ${route.url} must declare config.auth as 'public' or 'user'`,
      );
    }
    const contract = route.config?.contract;
    const declared = Object.keys(contract?.responses ?? {}).map(Number);
    if (!contract || !declared.some((status) => status >= 200 && status < 300)) {
      throw new Error(
        `Route ${methods.join(',')} ${route.url} must declare config.contract with at least one 2xx response`,
      );
    }
    for (const method of methods) {
      // Fastify adds HEAD for every GET with the same config; they are not separate surface.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      app.registeredRoutes.push({
        method,
        url: route.url,
        auth,
        mutating: MUTATING.has(method),
        contract,
      });
    }
  });
}
