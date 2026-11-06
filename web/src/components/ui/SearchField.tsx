import type { Ref } from 'react';

/** A search box with an icon, a screen-reader label and an optional "/" key hint (desktop only). */
export function SearchField({
  id,
  value,
  onChange,
  placeholder,
  inputRef,
  shortcut = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Show the "/" hint: only when the page really focuses this field on "/". */
  shortcut?: boolean;
}) {
  return (
    <div className="relative flex h-11 min-w-56 flex-1 items-center gap-2.5 rounded-xl bg-s1 px-3.5 shadow-line focus-within:shadow-[inset_0_0_0_1px_var(--color-blue),0_0_0_4px_rgb(10_139_255/0.18)]">
      <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 flex-none text-fg-3">
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      <input
        id={id}
        ref={inputRef}
        type="search"
        className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-3"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {shortcut && (
        <kbd
          aria-hidden="true"
          className="hidden rounded-[5px] border border-line-2 px-1.5 text-[0.6875rem] leading-[18px] text-fg-3 md:inline"
        >
          /
        </kbd>
      )}
    </div>
  );
}
