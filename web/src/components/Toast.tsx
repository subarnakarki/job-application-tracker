import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const SHOW_FOR_MS = 4000;

type Show = (message: string) => void;
const ToastContext = createContext<Show>(() => {});

/** Shows a short confirmation ("Saved Acme") at the bottom of the screen. Call from anywhere inside the Layout. */
export function useToast(): Show {
  return useContext(ToastContext);
}

/**
 * Confirmations only, never errors (those stay `role="alert"` next to what failed). One toast at a
 * time; a new one replaces the old. The region is always in the page, so a screen reader announces
 * each message politely, and it lives in the Layout so a toast survives the navigation after a save.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const counter = useRef(0);

  const hideLater = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), SHOW_FOR_MS);
  }, []);

  const show = useCallback<Show>(
    (message) => {
      counter.current += 1;
      setToast({ id: counter.current, message });
      hideLater();
    },
    [hideLater],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastContext value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4"
      >
        {toast && (
          <p
            key={toast.id}
            className="toast"
            onPointerEnter={() => window.clearTimeout(timer.current)}
            onPointerLeave={hideLater}
          >
            {toast.message}
          </p>
        )}
      </div>
    </ToastContext>
  );
}
