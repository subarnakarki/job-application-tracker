import type { Status } from '@jat/shared';
import type { CSSProperties } from 'react';
import { BAR_COUNT, STAGE_COLOR, stageFill } from '../../stage';

/** Decorative: the stage name is always written next to it. */
export function StageBars({ status }: { status: Status }) {
  const filled = stageFill(status);
  return (
    <span
      aria-hidden="true"
      className="stage-bars"
      style={{ '--c': STAGE_COLOR[status] } as CSSProperties}
    >
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <i key={index} className={index < filled ? 'on' : undefined} />
      ))}
    </span>
  );
}
