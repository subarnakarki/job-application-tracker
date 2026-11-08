import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_MS, ScreenCarousel, type Screen } from './ScreenCarousel';

const SCREENS: Screen[] = [
  { src: '/a.webp', label: 'Applications', alt: 'The list' },
  { src: '/b.webp', label: 'Board', alt: 'The board' },
  { src: '/c.webp', label: 'Apply queue', alt: 'The queue' },
];

/** Which screen is showing: the one image not hidden from screen readers. */
const showing = () => screen.getAllByRole('img').map((image) => image.getAttribute('alt'));
const current = () => screen.getByRole('button', { current: true }).textContent;

function reducedMotion(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({ matches: on && query.includes('reduce'), media: query }) as unknown as MediaQueryList,
  );
}

describe('ScreenCarousel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('moves to the next screen every few seconds, and back to the first', async () => {
    render(<ScreenCarousel screens={SCREENS} />);
    expect(showing()).toEqual(['The list']);
    expect(current()).toBe('Applications');
    await act(() => vi.advanceTimersByTime(SCREEN_MS));
    expect(showing()).toEqual(['The board']);
    await act(() => vi.advanceTimersByTime(SCREEN_MS * 2));
    expect(current()).toBe('Applications');
  });

  it('shows the screen picked, and stops when paused', async () => {
    render(<ScreenCarousel screens={SCREENS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply queue' }));
    expect(showing()).toEqual(['The queue']);
    fireEvent.click(screen.getByRole('button', { name: 'Pause the slideshow' }));
    // Focus left the buttons: only Pause holds it now.
    fireEvent.blur(screen.getByRole('button', { name: 'Play the slideshow' }));
    await act(() => vi.advanceTimersByTime(SCREEN_MS * 3));
    expect(current()).toBe('Apply queue');
    fireEvent.click(screen.getByRole('button', { name: 'Play the slideshow' }));
    fireEvent.blur(screen.getByRole('button', { name: 'Pause the slideshow' }));
    await act(() => vi.advanceTimersByTime(SCREEN_MS));
    expect(current()).toBe('Applications');
  });

  it('holds still while the pointer is over it', async () => {
    render(<ScreenCarousel screens={SCREENS} />);
    fireEvent.mouseEnter(screen.getByRole('region', { name: 'Screens from the app' }));
    await act(() => vi.advanceTimersByTime(SCREEN_MS * 2));
    expect(current()).toBe('Applications');
  });

  it('never moves by itself with reduced motion', async () => {
    reducedMotion(true);
    render(<ScreenCarousel screens={SCREENS} />);
    await act(() => vi.advanceTimersByTime(SCREEN_MS * 3));
    expect(current()).toBe('Applications');
    expect(screen.getByRole('button', { name: 'Play the slideshow' })).toBeInTheDocument();
  });
});
