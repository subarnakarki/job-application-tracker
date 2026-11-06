import type { Status } from '@jat/shared';
import { Pill } from './ui/Pill';
import { StageBars } from './ui/StageBars';

/** The stage as a pill: its bars and its name (colour is never the only signal). */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <Pill>
      <StageBars status={status} />
      {status}
    </Pill>
  );
}

/** A dot and the words "Needs follow-up", so it never relies on colour alone. */
export function FollowUpFlag() {
  return (
    <Pill tone="follow" dot>
      Needs follow-up
    </Pill>
  );
}
