import type { CSSProperties } from 'react';
import { initials } from '../../stage';

/** A decorative square with initials; the name is always written next to it. */
export function Avatar({
  name,
  color = 'var(--color-st-saved)',
  size = 'md',
  letters,
}: {
  name: string;
  /** Any CSS colour, normally a stage colour from `STAGE_COLOR`. */
  color?: string;
  size?: 'md' | 'xl';
  /** How many initials: 1 or 2. Defaults to 1 (2 when large). */
  letters?: 1 | 2;
}) {
  return (
    <span
      aria-hidden="true"
      className={size === 'xl' ? 'avatar avatar-xl' : 'avatar'}
      style={{ '--c': color } as CSSProperties}
    >
      {initials(name, letters ?? (size === 'xl' ? 2 : 1))}
    </span>
  );
}
