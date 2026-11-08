import { useEffect, useState } from 'react';

export interface Screen {
  src: string;
  /** Shown on its button. */
  label: string;
  /** What the screenshot shows, for screen readers. */
  alt: string;
}

/** Each screen is shown this long before the next. */
export const SCREEN_MS = 5000;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Screenshots of the app that take turns. They move on by themselves only when nothing says not to:
 * never with reduced motion, and not while the pointer or keyboard focus is on them, or after Pause.
 * A labelled button shows any screen directly.
 */
export function ScreenCarousel({ screens }: { screens: Screen[] }) {
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(() => prefersReducedMotion());
  const [held, setHeld] = useState(false);
  const playing = !paused && !held && screens.length > 1;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCurrent((index) => (index + 1) % screens.length);
    }, SCREEN_MS);
    return () => window.clearInterval(timer);
  }, [playing, screens.length]);

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Screens from the app"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
    >
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl">
        {screens.map((screen, index) => (
          <img
            key={screen.src}
            src={screen.src}
            alt={screen.alt}
            aria-hidden={index === current ? undefined : true}
            width={1500}
            height={1125}
            loading={index === 0 ? 'eager' : 'lazy'}
            decoding="async"
            className={`absolute inset-0 block size-full transition-opacity duration-700 motion-reduce:transition-none ${
              index === current ? 'opacity-100' : 'opacity-0'
            }`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 md:mt-4">
        {screens.map((screen, index) => (
          <button
            key={screen.src}
            type="button"
            aria-current={index === current ? 'true' : undefined}
            onClick={() => setCurrent(index)}
            className={`min-h-11 rounded-full px-3.5 text-[0.8125rem] transition-colors ${
              index === current ? 'bg-white text-black' : 'bg-white/[0.06] text-fg-2 hover:text-fg'
            }`}
          >
            {screen.label}
          </button>
        ))}
        {screens.length > 1 && (
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            aria-label={paused ? 'Play the slideshow' : 'Pause the slideshow'}
            className="grid size-11 place-items-center rounded-full bg-white/[0.06] text-fg-2 hover:text-fg"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
              {paused ? <path d="M8 5v14l11-7z" /> : <path d="M7 5h4v14H7zM13 5h4v14h-4z" />}
            </svg>
          </button>
        )}
      </div>
    </section>
  );
}
