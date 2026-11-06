import { Fragment, type CSSProperties, type ReactNode } from 'react';

/**
 * A heading whose words blur in one after another. The words are separated by real spaces, so the
 * heading's accessible name is still the plain text.
 */
export function RevealHeading({
  text,
  as: Tag = 'h1',
  className = 'display-h1',
}: {
  text: string;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <Tag className={`reveal ${className}`}>
      {words.map((word, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          <span className="w" style={{ '--i': Math.min(index, 12) } as CSSProperties}>
            {word}
          </span>
        </Fragment>
      ))}
    </Tag>
  );
}

/** The top of a page: a huge title, an optional line under it, and actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <RevealHeading text={title} />
        {subtitle && (
          <p className="rise rise-3 mt-3 max-w-[56ch] text-[1.0625rem] tracking-[-0.015em] text-fg-2">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="rise rise-4 flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}
