import type { CSSProperties } from 'react';

interface Props<T extends string> {
  /** The group's accessible name, e.g. "View". */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** A row of toggle buttons (aria-pressed) with a white thumb that slides under the chosen one. */
export function Segmented<T extends string>({ label, options, value, onChange }: Props<T>) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div
      role="group"
      aria-label={label}
      className="seg"
      style={{ '--n': options.length, '--i': index } as CSSProperties}
    >
      <span aria-hidden="true" className="seg-thumb" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
