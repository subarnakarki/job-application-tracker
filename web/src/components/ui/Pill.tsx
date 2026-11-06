import type { ReactNode } from 'react';

type Tone = 'follow' | 'iv' | 'neutral';

/** A small rounded label. It always carries text, so colour is never the only signal. */
export function Pill({
  tone = 'neutral',
  dot = false,
  className = '',
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`pill pill-${tone} ${className}`}>
      {dot && <i aria-hidden="true" />}
      {children}
    </span>
  );
}
