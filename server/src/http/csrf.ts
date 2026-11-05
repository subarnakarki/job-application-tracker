export interface RequestFacts {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export type RequestCheck =
  | { ok: true }
  | {
      ok: false;
      statusCode: 403 | 415;
      code: 'cross_site_request' | 'unsupported_media_type';
      message: string;
    };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * CSRF defence for a cookie-session API, without tokens:
 *
 * - Browsers label every request with `Sec-Fetch-Site`. A state-changing request
 *   must be `same-origin`; `same-site` (a sibling subdomain) and `cross-site` are refused.
 * - Where that header is missing, `Origin` must match the host being called.
 * - A request with neither header is not from a browser (curl, tests, other
 *   servers), and cannot ride a victim's cookie, so it passes.
 * - A request body must be `application/json`. A cross-site HTML form can only
 *   send form or text content types, so this closes the "simple request" route.
 *
 * Reads (GET, HEAD, OPTIONS) are never state-changing here and are not checked.
 */
export function checkRequest({ method, headers }: RequestFacts): RequestCheck {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const fetchSite = first(headers['sec-fetch-site']);
  const origin = first(headers['origin']);
  if (fetchSite !== undefined) {
    if (fetchSite !== 'same-origin') return refuse('Cross-site requests are not allowed');
  } else if (origin !== undefined) {
    if (!originMatchesHost(origin, first(headers['host'])))
      return refuse('Cross-site requests are not allowed');
  }

  const hasBody =
    Number(first(headers['content-length']) ?? 0) > 0 ||
    first(headers['transfer-encoding']) !== undefined;
  if (hasBody) {
    const mediaType = (first(headers['content-type']) ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return {
        ok: false,
        statusCode: 415,
        code: 'unsupported_media_type',
        message: 'Send the request body as application/json',
      };
    }
  }
  return { ok: true };
}

function refuse(message: string): RequestCheck {
  return { ok: false, statusCode: 403, code: 'cross_site_request', message };
}

function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // includes the literal "null" origin sent by sandboxed contexts
  }
}
