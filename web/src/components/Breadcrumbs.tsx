import { Link } from 'react-router';

export interface Crumb {
  label: string;
  /** Left out for the page you are on. */
  to?: string;
}

/**
 * Where a page sits: "Applications › Acme › Edit". Each step back is a link; the last is the page
 * itself, marked as current. On phones the middle steps fold away, keeping the way back.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="-mb-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-fg-3">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          const middle = index > 0 && !last;
          return (
            <li
              key={`${item.label}-${String(index)}`}
              className={`flex min-w-0 items-center gap-1.5 ${middle && items.length > 3 ? 'max-sm:hidden' : ''}`}
            >
              {index > 0 && (
                <span aria-hidden="true" className="text-fg-4">
                  ›
                </span>
              )}
              {item.to && !last ? (
                <Link
                  to={item.to}
                  className="flex min-h-11 items-center truncate transition-colors hover:text-fg"
                >
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className="truncate text-fg-2">
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
