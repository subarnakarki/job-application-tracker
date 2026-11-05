import type { RegisteredRoute } from '../http/policy';

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/** `/api/applications/:id` -> a concrete URL, for probing a route pattern. */
export function fillUrl(pattern: string): string {
  return pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PLACEHOLDER_ID);
}

export const routeKey = (route: Pick<RegisteredRoute, 'method' | 'url'>): string =>
  `${route.method} ${route.url}`;

export function hasPathParams(route: Pick<RegisteredRoute, 'url'>): boolean {
  return /:[A-Za-z_]/.test(route.url);
}

export interface CoverageProblems {
  /** Signed-in routes addressing a record by id that no isolation test claims. */
  uncovered: string[];
  /** Claims that point at a route that no longer exists. */
  stale: string[];
}

/**
 * A route that takes an id and needs a session is where one user could reach
 * another's data. Each must be named in `covered` (mapped to the test that
 * proves another user gets 404), so adding one without that test fails the build.
 */
export function checkIsolationCoverage(
  routes: readonly RegisteredRoute[],
  covered: Readonly<Record<string, string>>,
): CoverageProblems {
  const needing = routes
    .filter((route) => route.auth === 'user' && hasPathParams(route))
    .map(routeKey);
  const known = new Set(routes.map(routeKey));
  return {
    uncovered: needing.filter((key) => !(key in covered)).sort(),
    stale: Object.keys(covered)
      .filter((key) => !known.has(key))
      .sort(),
  };
}
