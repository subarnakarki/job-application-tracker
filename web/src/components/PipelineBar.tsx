import type { Pipeline, Status } from '@jat/shared';
import type { CSSProperties } from 'react';
import { STAGE_COLOR } from '../stage';
import { useCountUp } from '../useCountUp';

interface Props {
  pipeline: Pipeline | undefined;
  selected: Status | undefined;
  /** Called with the stage to show, or undefined to clear (tapping the selected stage again). */
  onSelect: (status: Status | undefined) => void;
}

function Count({ value }: { value: number }) {
  return <>{useCountUp(value)}</>;
}

/**
 * One button per stage: its count, large, above its name. The name comes first in the markup (so a
 * button's name starts with the stage) and the count is shown above it by `flex-col-reverse`.
 * Under the buttons, a funnel of bars grows with each stage's count.
 */
export function PipelineBar({ pipeline, selected, onSelect }: Props) {
  const stages = pipeline?.stages ?? [];
  const most = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Pipeline stages"
        className="-mx-2 flex snap-x gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none] md:grid md:grid-cols-7 md:overflow-visible"
      >
        {stages.map(({ status, count }) => {
          const active = selected === status;
          const closed = status === 'Rejected' || status === 'Withdrawn';
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? undefined : status)}
              className={`flex min-h-11 min-w-[4.75rem] shrink-0 snap-start flex-col-reverse items-start justify-end gap-2 rounded-[0.875rem] px-3 pt-3 pb-2.5 text-left transition-[background-color,box-shadow] hover:bg-white/5 ${
                active ? 'bg-white/10 shadow-line-2' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-2">
                <i
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    background: STAGE_COLOR[status],
                    boxShadow: `0 0 10px ${STAGE_COLOR[status]}`,
                  }}
                />
                {status}
              </span>
              <span
                className={`block text-[2rem] leading-none font-semibold tracking-[-0.05em] tabular-nums md:text-[2.5rem] ${
                  closed ? 'text-fg-3' : ''
                }`}
              >
                <Count value={count} />
              </span>
            </button>
          );
        })}
      </div>
      <div aria-hidden="true" className="hidden h-[46px] items-end gap-1.5 md:flex">
        {stages.map(({ status, count }, index) => (
          <span
            key={status}
            className="funnel-bar flex-1"
            style={
              {
                '--c': STAGE_COLOR[status],
                '--i': index,
                height: `${Math.max(6, Math.round((count / most) * 100))}%`,
              } as CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
