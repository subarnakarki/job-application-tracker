import type { StageCounts } from '@jat/shared';
import { Link } from 'react-router';
import { useStats } from '../api/hooks';

const COLUMNS = [
  { key: 'total', label: 'Applications' },
  { key: 'applied', label: 'Applied' },
  { key: 'responded', label: 'Responded' },
  { key: 'interviewing', label: 'Interviewed' },
  { key: 'offers', label: 'Offers' },
] as const;

function rate(counts: StageCounts): string {
  return counts.responseRate === null ? '–' : `${Math.round(counts.responseRate * 100)}%`;
}

/** Response rate and stage counts per source. A table on wide screens, cards on phones. */
export function StatsPage() {
  const stats = useStats();

  if (stats.isPending) return <p className="text-sm">Loading…</p>;
  if (stats.isError)
    return (
      <p role="alert" className="text-sm text-rose-700">
        Could not load the stats. Try again shortly.
      </p>
    );

  const { sources, totals } = stats.data;
  const rows = sources.filter((row) => row.total > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Stats by source</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          &quot;Responded&quot; means the application reached Screening or later, or was rejected
          after you applied. The response rate is responded ÷ applied.
        </p>
      </div>

      {totals.total === 0 ? (
        <p className="text-slate-600 dark:text-slate-300">
          No applications yet.{' '}
          <Link to="/applications/new" className="text-blue-700 underline dark:text-blue-400">
            Add one
          </Link>{' '}
          to see stats.
        </p>
      ) : (
        <>
          <table className="hidden w-full text-left text-sm sm:table">
            <caption className="sr-only">Applications by source</caption>
            <thead className="border-b border-slate-300 dark:border-slate-700">
              <tr>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Source
                </th>
                {COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className="px-3 py-2 text-right font-semibold">
                    {column.label}
                  </th>
                ))}
                <th scope="col" className="py-2 pl-3 text-right font-semibold">
                  Response rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.source} className="border-b border-slate-200 dark:border-slate-800">
                  <th scope="row" className="py-2 pr-3 font-medium">
                    {row.source}
                  </th>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className="px-3 py-2 text-right tabular-nums">
                      {row[column.key]}
                    </td>
                  ))}
                  <td className="py-2 pl-3 text-right tabular-nums">{rate(row)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <th scope="row" className="py-2 pr-3">
                  All sources
                </th>
                {COLUMNS.map((column) => (
                  <td key={column.key} className="px-3 py-2 text-right tabular-nums">
                    {totals[column.key]}
                  </td>
                ))}
                <td className="py-2 pl-3 text-right tabular-nums">{rate(totals)}</td>
              </tr>
            </tfoot>
          </table>

          <ul className="flex flex-col gap-3 sm:hidden" aria-label="Applications by source">
            {[
              ...rows.map((row) => ({ name: row.source, counts: row })),
              { name: 'All sources', counts: totals },
            ].map(({ name, counts }) => (
              <li
                key={name}
                className="rounded-lg border border-slate-300 p-3 dark:border-slate-700"
              >
                <h2 className="font-semibold">{name}</h2>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  {COLUMNS.map((column) => (
                    <div key={column.key}>
                      <dt className="text-slate-600 dark:text-slate-300">{column.label}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{counts[column.key]}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-slate-600 dark:text-slate-300">Response rate</dt>
                    <dd className="text-lg font-semibold tabular-nums">{rate(counts)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
