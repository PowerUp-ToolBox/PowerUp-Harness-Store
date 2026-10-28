import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConnectivityState } from '../../../shared/ipc.js';

export interface ConnectivityContextValue {
  /** Whether the Store answers, as the Runtime last saw it. */
  readonly state: ConnectivityState;
  /** True while a check the User asked for (Retry) runs. */
  readonly checking: boolean;
  /** Asks the Runtime to check the Store now (`connectivity.check`). */
  readonly retry: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

/**
 * Follows the Runtime's view of the Store's connectivity: the current state on mount
 * (`connectivity.get`), then every `connectivity.changed` event. The Runtime does the checking;
 * the renderer only asks for a check when the User presses Retry.
 */
export function ConnectivityProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ConnectivityState>('unknown');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let current = true;
    // Subscribe first, so a change pushed while connectivity.get is on its way is not lost.
    const unsubscribe = window.api.on('connectivity.changed', (connectivity) => {
      if (current) setState(connectivity.state);
    });
    // A failed call leaves the state unknown: nothing is blocked, and Store requests report
    // their own failures.
    void window.api.connectivity.get().then(
      (result) => {
        if (current && result.ok) setState(result.data.state);
      },
      () => undefined,
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  const retry = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.api.connectivity.check();
      if (result.ok) setState(result.data.state);
    } catch {
      // The state stays as it was; the User can press Retry again.
    } finally {
      setChecking(false);
    }
  }, []);

  const value = useMemo(() => ({ state, checking, retry }), [state, checking, retry]);
  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityContextValue {
  const value = useContext(ConnectivityContext);
  if (value === null) throw new Error('useConnectivity must be used inside <ConnectivityProvider>');
  return value;
}
