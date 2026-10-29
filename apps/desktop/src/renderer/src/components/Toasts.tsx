import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** How long a toast stays before it goes by itself. */
export const TOAST_DURATION_MS = 4200;

/** Shows a toast: a short confirmation in the UI language, already translated. */
export type ShowToast = (text: string) => void;

const ToastContext = createContext<ShowToast | null>(null);

interface Toast {
  readonly id: number;
  readonly text: string;
}

/**
 * The main window's toast area (docs/ux/screens.md, main window shell: "Global toast area
 * bottom-right"): short confirmations such as "Installed Hello Web", newest last, each gone after
 * a few seconds. It is a polite live region, there before any toast, so a screen reader reads
 * each one once without interrupting; toasts carry no action, so nothing is lost when one goes.
 */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const show = useCallback<ShowToast>((text) => {
    const id = ++next.current;
    setToasts((current) => [...current, { id, text }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    timers.current.add(timer);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} className="toast">
            {toast.text}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}
