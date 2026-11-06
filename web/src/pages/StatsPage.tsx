import type { StageCounts } from '@jat/shared';
import { Link } from 'react-router';
import { useStats } from '../api/hooks';
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';
import { useCountUp } from '../useCountUp';
import { useSpotlight } from '../useSpotlight';

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

function Count({ value }: { value: number }) {
  return <>{useCountUp(value)}</>;
}

/** Response rate and stage counts per source. A table on wide screens, cards on phones. */
export function StatsPage() {
  const stats = useStats();
  const spotlight = useSpotlight();

  if (stats.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (stats.isError)
    return (
      <p role="alert" className="text-sm text-red">
        Could not load the stats. Try again shortly.
      </p>
    );

  const { sources, totals } = stats.data;
  const rows = sources.filter((row) => row.total > 0);
  const kpis = [
    { label: 'Applications', value: totals.total },
    { label: 'Applied', value: totals.applied },
    { label: 'Responded', value: totals.responded },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Stats by source"
        subtitle={
          <>
            &quot;Responded&quot; means the application reached Screening or later, or was rejected
            after you applied. The response rate is responded ÷ applied.
          </>
        }
      />

      {totals.total === 0 ? (
        <p className="text-fg-2">
          No applications yet.{' '}
          <Link to="/applications/new" className="link underline">
            Add one
          </Link>{' '}
          to see stats.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {kpis.map((kpi, index) => (
              <Glow key={kpi.label} className={`rise rise-${index + 3} p-5`}>
                <dt className="text-[0.8125rem] font-medium text-fg-2">{kpi.label}</dt>
                <dd className="mt-3.5 text-[2.75rem] leading-none font-[650] tracking-[-0.055em] tabular-nums sm:text-[3.5rem]">
                  <Count value={kpi.value} />
                </dd>
              </Glow>
            ))}
            <Glow className="rise rise-6 p-5">
              <dt className="text-[0.8125rem] font-medium text-fg-2">Response rate</dt>
              <dd className="grad-text mt-3.5 text-[2.75rem] leading-none font-[650] tracking-[-0.055em] tabular-nums sm:text-[3.5rem]">
                {rate(totals)}
              </dd>
            </Glow>
          </dl>

          <Glow as="section" aria-labelledby="rate-heading" className="rise rise-7 p-5">
            <h2
              id="rate-heading"
              className="flex justify-between gap-3 text-[0.8125rem] font-medium text-fg-2"
            >
              <span>Response rate by source</span>
              <span>responded ÷ applied</span>
            </h2>
            <ul className="mt-4 flex flex-col gap-3" aria-label="Response rate by source">
              {rows.map((row) => (
                <li
                  key={row.source}
                  className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-3.5 text-sm sm:grid-cols-[7.5rem_1fr_3rem]"
                >
                  <span className="truncate">{row.source}</span>
                  <span
                    aria-hidden="true"
                    className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]"
                  >
                    <i
                      className="rate-bar block h-full rounded-full"
                      style={{ width: `${Math.round((row.responseRate ?? 0) * 100)}%` }}
                    />
                  </span>
                  <span className="text-right text-fg-2 tabular-nums">{rate(row)}</span>
                </li>
              ))}
            </ul>
          </Glow>

          <Glow className="rise rise-8 hidden p-1.5 sm:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Applications by source</caption>
              <thead>
                <tr className="text-xs text-fg-3">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Source
                  </th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} scope="col" className="px-4 py-3 text-right font-medium">
                      {column.label}
                    </th>
                  ))}
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Response rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.source} className="border-t border-line">
                    <th scope="row" className="px-4 py-3 font-medium">
                      {row.source}
                    </th>
                    {COLUMNS.map((column) => (
                      <td key={column.key} className="px-4 py-3 text-right text-fg-2 tabular-nums">
                        {row[column.key]}
                      </td>
                    ))}
                    <td className="px-4 py-3 text-right text-fg-2 tabular-nums">{rate(row)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line-2 font-semibold">
                  <th scope="row" className="px-4 py-3">
                    Total
                  </th>
                  {COLUMNS.map((column) => (
                    <td key={column.key} className="px-4 py-3 text-right tabular-nums">
                      {totals[column.key]}
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right tabular-nums">{rate(totals)}</td>
                </tr>
              </tfoot>
            </table>
          </Glow>

          <ul className="flex flex-col gap-3 sm:hidden" aria-label="Applications by source">
            {[
              ...rows.map((row) => ({ name: row.source, counts: row })),
              { name: 'Total', counts: totals },
            ].map(({ name, counts }) => (
              <li key={name} {...spotlight} className="glow p-4">
                <h2 className="font-semibold">{name}</h2>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  {COLUMNS.map((column) => (
                    <div key={column.key}>
                      <dt className="text-fg-2">{column.label}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{counts[column.key]}</dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-fg-2">Response rate</dt>
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
