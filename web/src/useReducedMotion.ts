import { useMediaQuery } from './useMediaQuery';

/** Whether the person asked the system for less motion. JS animations check this themselves. */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
