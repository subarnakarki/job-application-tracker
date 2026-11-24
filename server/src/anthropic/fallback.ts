/** Haiku models take neither server-side fallback nor the dynamic-filtering web search tool. */
export const isHaiku = (model: string): boolean => model.startsWith('claude-haiku');

/**
 * The server-side refusal fallback for a request to `model`: Anthropic's default routing on models that
 * have it, nothing on Haiku (a declined Haiku request stays declined, and the caller's own `refusal`
 * handling takes over).
 */
export function fallbackFor(
  model: string,
): { betas: ['server-side-fallback-2026-07-01']; fallbacks: 'default' } | Record<string, never> {
  return isHaiku(model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}
