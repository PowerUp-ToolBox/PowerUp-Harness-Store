import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthState, FolderValidation, IpcError } from '../../../shared/ipc.js';

/** Where the validation of the chosen folder is. */
export type FolderCheck =
  /** A run is under way; `previous` is the last result for this folder, still shown meanwhile. */
  | { readonly kind: 'checking'; readonly previous: FolderValidation | null }
  | { readonly kind: 'done'; readonly result: FolderValidation }
  | { readonly kind: 'error'; readonly error: IpcError };

/** The "New version" flow: the chosen folder, its validation, and whether it is in review. */
export interface PublishFlow {
  /** The folder chosen to publish from, absolute; null before one is chosen. */
  readonly folder: string | null;
  /** Null exactly when no folder is chosen. */
  readonly check: FolderCheck | null;
  /**
   * The review step (F5 steps 4 and 5): only while the folder is valid. A run that finds a
   * problem ends it; one that finds none keeps it.
   */
  readonly reviewing: boolean;
  /** The last drop was not a folder; cleared by the next action. */
  readonly dropRefused: boolean;
}

export interface PublishContextValue {
  /** Who is signed in to the Store; null until the Runtime answered. */
  readonly auth: AuthState | null;
  /** Asks the Runtime who is signed in (`auth.whoami`); the Publish screen calls it as it opens. */
  readonly loadAuth: () => void;
  /** A sign-in is waiting for the browser. */
  readonly signingIn: boolean;
  /** Why the last sign-in or sign-out failed. */
  readonly authError: IpcError | null;
  /** The session ended by itself (`session_expired`): the sign-in card says so. */
  readonly sessionExpired: boolean;
  readonly signIn: () => Promise<void>;
  /** Cancels the sign-in waiting for the browser (`auth.signOut` cancels it). */
  readonly cancelSignIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly flow: PublishFlow;
  /** The OS folder picker, then validation of the chosen folder at once. */
  readonly chooseFolder: () => Promise<void>;
  /** Validates a folder dropped on the screen; a file is refused (`dropRefused`). */
  readonly dropFolder: (path: string) => Promise<void>;
  /** Validates the chosen folder again now. */
  readonly recheck: () => Promise<void>;
  /** Continue: the review step, for a folder without problems. */
  readonly review: () => void;
  /** Back from the review step. */
  readonly back: () => void;
}

const PublishContext = createContext<PublishContextValue | null>(null);

const NO_FOLDER: PublishFlow = { folder: null, check: null, reviewing: false, dropRefused: false };

/** The chosen folder, validated again, is no longer a folder (`invalid_input`). */
const FOLDER_GONE: IpcError = {
  code: 'package_invalid',
  messageKey: 'error.package_invalid',
  message: 'The folder is no longer a folder. Choose it again.',
};

/**
 * The Publish screen's state (flow F5), held above the screens so leaving Publish and coming back
 * keeps the chosen folder, its validation and the review step; the Runtime keeps watching the
 * folder meanwhile. It follows the Store sign-in (`auth.*`, `auth.changed`; `auth.whoami` only
 * once the Publish screen opens, so a User who never publishes costs the Store nothing), and
 * validates the folder with `publish.validateFolder`: when it is chosen (picker or drop), on
 * Re-check, when the Runtime reports it changed (`publish.folderChanged`), and after a sign-in,
 * since the checks depend on who is signed in. Runs are numbered and only the newest one's answer
 * is kept. A sign-out, an expired session included, keeps the folder.
 */
export function PublishProvider({ children }: { readonly children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<IpcError | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [flow, setFlowState] = useState<PublishFlow>(NO_FOLDER);
  const flowRef = useRef(flow);
  const runs = useRef(0);
  const mounted = useRef(true);

  const setFlow = useCallback((next: PublishFlow | ((current: PublishFlow) => PublishFlow)) => {
    flowRef.current = typeof next === 'function' ? next(flowRef.current) : next;
    setFlowState(flowRef.current);
  }, []);

  const validate = useCallback(
    (path: string) => {
      /** Validates `target`; false when a newer run replaced this one and its answer was dropped. */
      const run = async (target: string): Promise<boolean> => {
        runs.current += 1;
        const at = runs.current;
        const before = flowRef.current;
        const same = before.folder === target;
        const previous =
          !same || before.check === null
            ? null
            : before.check.kind === 'done'
              ? before.check.result
              : before.check.kind === 'checking'
                ? before.check.previous
                : null;
        setFlow({
          folder: target,
          check: { kind: 'checking', previous },
          reviewing: same && before.reviewing,
          dropRefused: false,
        });
        const result = await window.api.publish.validateFolder(target);
        if (!mounted.current || at !== runs.current) return false;
        const notFolder = !result.ok && result.error.code === 'invalid_input';
        if (notFolder && !same) {
          // A dropped file: the folder chosen before stays, as it was, and a run of it this one
          // replaced runs again (a run of that folder never comes back here).
          setFlow({ ...before, dropRefused: true });
          // The refusal stays shown unless a newer action replaced that run meanwhile.
          if (before.folder !== null && before.check?.kind === 'checking') {
            if (await run(before.folder)) setFlow((current) => ({ ...current, dropRefused: true }));
          }
          return true;
        }
        setFlow((current) => ({
          ...current,
          check: result.ok
            ? { kind: 'done', result: result.data }
            : // The chosen folder was replaced by a file: it changed since it was checked.
              { kind: 'error', error: notFolder ? FOLDER_GONE : result.error },
          reviewing: current.reviewing && result.ok && result.data.problems.length === 0,
        }));
        return true;
      };
      return run(path);
    },
    [setFlow],
  );

  /** Who is signed in, asked again each time the Publish screen opens (the profile may change). */
  const loadAuth = useCallback(() => {
    void window.api.auth.whoami().then((result) => {
      if (mounted.current && result.ok) setAuth(result.data);
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const offAuth = window.api.on('auth.changed', ({ reason, ...state }) => {
      setAuth(state.signedIn ? state : { signedIn: false });
      if (reason === 'session_expired') setSessionExpired(true);
      if (reason === 'signed_in') setSessionExpired(false);
    });
    const offFolder = window.api.on('publish.folderChanged', ({ path }) => {
      if (flowRef.current.folder === path) void validate(path);
    });
    return () => {
      mounted.current = false;
      offAuth();
      offFolder();
      void window.api.publish.stopWatching();
    };
  }, [validate]);

  // Signing in, again or as someone else, changes the Publisher checks: validate the folder again.
  const login = auth?.signedIn === true ? auth.githubLogin : null;
  const lastLogin = useRef<string | null>(null);
  useEffect(() => {
    const changed = login !== null && login !== lastLogin.current;
    lastLogin.current = login;
    const { folder } = flowRef.current;
    if (changed && folder !== null) void validate(folder);
  }, [login, validate]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setAuthError(null);
    const result = await window.api.auth.signIn();
    if (!mounted.current) return;
    setSigningIn(false);
    if (result.ok) {
      setAuth(result.data);
      setSessionExpired(false);
    } else if (result.error.code !== 'sign_in_cancelled') {
      setAuthError(result.error);
    }
  }, []);

  const cancelSignIn = useCallback(async () => {
    await window.api.auth.signOut();
  }, []);

  const signOut = useCallback(async () => {
    setAuthError(null);
    const result = await window.api.auth.signOut();
    if (!mounted.current) return;
    if (result.ok) {
      setAuth(result.data);
      setSessionExpired(false);
    } else {
      setAuthError(result.error);
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    setFlow((current) => ({ ...current, dropRefused: false }));
    const result = await window.api.installs.chooseFolder();
    if (mounted.current && result.ok && result.data !== null) await validate(result.data);
  }, [setFlow, validate]);

  const dropFolder = useCallback(
    async (path: string) => {
      if (path === '') setFlow((current) => ({ ...current, dropRefused: true }));
      else await validate(path);
    },
    [setFlow, validate],
  );

  const recheck = useCallback(async () => {
    const { folder } = flowRef.current;
    if (folder !== null) await validate(folder);
  }, [validate]);

  const review = useCallback(() => {
    setFlow((current) =>
      current.check?.kind === 'done' && current.check.result.problems.length === 0
        ? { ...current, reviewing: true }
        : current,
    );
  }, [setFlow]);

  const back = useCallback(() => {
    setFlow((current) => ({ ...current, reviewing: false }));
  }, [setFlow]);

  const value = useMemo<PublishContextValue>(
    () => ({
      auth,
      loadAuth,
      signingIn,
      authError,
      sessionExpired,
      signIn,
      cancelSignIn,
      signOut,
      flow,
      chooseFolder,
      dropFolder,
      recheck,
      review,
      back,
    }),
    [
      auth,
      loadAuth,
      signingIn,
      authError,
      sessionExpired,
      signIn,
      cancelSignIn,
      signOut,
      flow,
      chooseFolder,
      dropFolder,
      recheck,
      review,
      back,
    ],
  );
  return <PublishContext.Provider value={value}>{children}</PublishContext.Provider>;
}

export function usePublish(): PublishContextValue {
  const value = useContext(PublishContext);
  if (value === null) throw new Error('usePublish must be used inside <PublishProvider>');
  return value;
}
