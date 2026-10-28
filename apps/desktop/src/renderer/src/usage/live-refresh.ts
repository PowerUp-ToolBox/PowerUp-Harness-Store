import { useEffect, useRef } from 'react';

/** The least time between two refreshes of the Usage page. */
export const USAGE_REFRESH_MS = 2000;

/**
 * Calls `refresh` when the Model Gateway writes a Usage Record (`usage.recorded`), while the
 * calling page is mounted and the window is visible, at most once every
 * {@link USAGE_REFRESH_MS}: the first record refreshes at once, and records during the wait that
 * follows refresh once more at its end, so the last one always shows. Records while the window is
 * hidden refresh once when it shows again.
 */
export function useUsageRecorded(refresh: () => void): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** A record arrived during the wait. */
    let pending = false;
    /** A record arrived while the window was hidden. */
    let missed = false;
    const visible = () => document.visibilityState === 'visible';

    const run = () => {
      latest.current();
      timer = setTimeout(() => {
        timer = null;
        if (!pending) return;
        pending = false;
        if (visible()) run();
        else missed = true;
      }, USAGE_REFRESH_MS);
    };
    const recorded = () => {
      if (!visible()) missed = true;
      else if (timer === null) run();
      else pending = true;
    };
    const visibilityChanged = () => {
      if (!visible() || !missed) return;
      missed = false;
      recorded();
    };

    const unsubscribe = window.api.on('usage.recorded', recorded);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
