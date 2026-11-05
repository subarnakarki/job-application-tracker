export interface ClientIpInput {
  headers: Record<string, string | string[] | undefined>;
  /** The socket peer as Fastify reports it. */
  remoteAddress: string | undefined;
  env: Record<string, string | undefined>;
}

/**
 * The address to rate-limit on. Behind Vercel the socket peer is Vercel's
 * proxy, and `x-vercel-forwarded-for` (which Vercel sets and overwrites) holds
 * the real client. That header is trusted only when running on Vercel;
 * anywhere else a client could send it to dodge or frame someone with a limit.
 */
export function clientIp({ headers, remoteAddress, env }: ClientIpInput): string {
  if (env['VERCEL'] === '1') {
    const header = headers['x-vercel-forwarded-for'];
    const value = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    if (value) return normalise(value);
  }
  return remoteAddress ? normalise(remoteAddress) : 'unknown';
}

function normalise(address: string): string {
  return address
    .toLowerCase()
    .replace(/^::ffff:/, '')
    .slice(0, 64);
}
