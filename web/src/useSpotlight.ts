import type { PointerEvent } from 'react';
import { useReducedMotion } from './useReducedMotion';

/** Moves the highlight on a `.glow` surface's border to the pointer (CSS variables --mx and --my). */
function track(event: PointerEvent<HTMLElement>) {
  if (event.pointerType === 'touch') return;
  const element = event.currentTarget;
  const box = element.getBoundingClientRect();
  element.style.setProperty('--mx', `${event.clientX - box.left}px`);
  element.style.setProperty('--my', `${event.clientY - box.top}px`);
}

/** Props to spread on any element with the `glow` class. Nothing follows the pointer with reduced motion. */
export function useSpotlight(): { onPointerMove?: (event: PointerEvent<HTMLElement>) => void } {
  return useReducedMotion() ? {} : { onPointerMove: track };
}
