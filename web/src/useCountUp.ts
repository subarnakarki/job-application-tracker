import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

/** A number that ticks up to `target` (from wherever it was), or is simply `target` with reduced motion. */
export function useCountUp(target: number, durationMs = 900): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const from = latest.current;
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      latest.current = Math.round(from + (target - from) * eased);
      setShown(latest.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduced]);

  return reduced ? target : shown;
}
