import type { Pipeline, Status } from '@jat/shared';

interface Props {
  pipeline: Pipeline | undefined;
  selected: Status | undefined;
  /** Called with the stage to show, or undefined to clear (tapping the selected stage again). */
  onSelect: (status: Status | undefined) => void;
}

/** One button per stage with its count. Scrolls sideways on small screens. */
export function PipelineBar({ pipeline, selected, onSelect }: Props) {
  return (
    <div
      role="group"
      aria-label="Pipeline stages"
      className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2"
    >
      {(pipeline?.stages ?? []).map(({ status, count }) => {
        const active = selected === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(active ? undefined : status)}
            className={`min-h-11 shrink-0 snap-start rounded-lg border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
              active
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'
            }`}
          >
            <span className="block font-medium">{status}</span>
            <span className="block text-lg font-semibold tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
