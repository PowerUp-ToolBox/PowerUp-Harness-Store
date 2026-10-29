import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { InstalledHarness, IpcError, LaunchStatus } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { WorkspaceSheet } from './WorkspaceSheet.js';

/** How an installed Harness is launched from a button: the Library card's and the detail page's. */
export interface LaunchControls {
  /** Nothing can fill its `default` Model Slot: the button reads "Set up a model first". */
  readonly needsModel: boolean;
  /** Launch: through the Workspace sheet when the Harness's Manifest asks for a Workspace. */
  readonly launch: () => void;
  /** A launch while it runs, which brings its window to the front. */
  readonly focus: () => void;
  /** The Models page at this Harness's card. */
  readonly openModels: () => void;
  /** The Workspace sheet while it is open; render it next to the button. */
  readonly sheet: ReactNode;
}

/**
 * The launch of one installed Harness (docs/ux/flows.md F3), shared by the Library card and the
 * Store detail page so the two can never behave differently: whether its `default` Model Slot can
 * be filled (`bindings.resolveAll`), the Workspace sheet for a Harness that asks for a Workspace,
 * and `launch.start`. A launch refused with `slot_unbound` turns the button into "Set up a model
 * first"; any other refusal goes to `onError`, which is cleared (null) when a launch begins.
 */
export function useLaunch(
  install: InstalledHarness,
  onError: (error: IpcError | null) => void,
): LaunchControls {
  const navigate = useNavigate();
  const [needsModel, setNeedsModel] = useState(false);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const { harnessId } = install;

  useEffect(() => {
    let current = true;
    void window.api.bindings.resolveAll(harnessId).then((result) => {
      if (!current || !result.ok) return;
      const slot = result.data.find((each) => each.slot === 'default');
      setNeedsModel(slot?.binding === null);
    });
    return () => {
      current = false;
    };
  }, [harnessId]);

  /** Launches it, or focuses it while it runs; resolves the error to show, if any. */
  const start = async (workspace?: string | null): Promise<IpcError | null> => {
    const result = await window.api.launch.start(
      workspace === undefined ? { harnessId } : { harnessId, workspace },
    );
    if (result.ok) return null;
    if (result.error.code !== 'slot_unbound') return result.error;
    setNeedsModel(true);
    return null;
  };
  const focus = () => {
    onError(null);
    void start().then(onError);
  };
  return {
    needsModel,
    launch: () => {
      if ((install.manifest.workspace ?? 'none') === 'none') focus();
      else setChoosingWorkspace(true);
    },
    focus,
    openModels: () => {
      void navigate(`/models?harness=${encodeURIComponent(harnessId)}`);
    },
    sheet: choosingWorkspace ? (
      <WorkspaceSheet
        install={install}
        onLaunch={(workspace) => {
          onError(null);
          return start(workspace);
        }}
        onClose={() => {
          setChoosingWorkspace(false);
        }}
      />
    ) : null,
  };
}

/**
 * The primary button of an installed Harness (docs/ux/design-principles.md §3): Launch;
 * "Starting…" while it starts; "Running…" with "Show window" while it runs (both bring its window
 * to the front, as a second launch would); "Stopping…" after its window closed; "Set up a model
 * first", which opens the Models page at this Harness, when nothing can fill its `default` Model
 * Slot; "Not available for your platform", disabled. There is no Stop: closing the Harness's
 * window stops it with the shutdown sequence (flows.md F3 step 7). `secondary` follows Launch
 * (the detail page's Uninstall). `lead` takes the primary place while the Harness is not running
 * (the detail page's Update); Launch, or "Set up a model first", then follows it as a link.
 */
export function LaunchAction({
  install,
  state,
  controls,
  secondary,
  lead,
}: {
  readonly install: InstalledHarness;
  readonly state: LaunchStatus['state'] | undefined;
  readonly controls: LaunchControls;
  readonly secondary?: ReactNode;
  readonly lead?: ReactNode;
}) {
  const { t } = useI18n();
  if (!install.platformSupported) {
    return (
      <button type="button" className="button-primary" disabled>
        {t('library.unsupported')}
      </button>
    );
  }
  switch (state) {
    case 'preparing':
    case 'spawning':
    case 'waiting-ready':
      return (
        <button type="button" className="button-primary" disabled>
          {t('library.starting')}
        </button>
      );
    case 'ready':
      return (
        <>
          <button type="button" className="button-primary" onClick={controls.focus}>
            {t('library.running')}
          </button>
          <button type="button" className="button-link" onClick={controls.focus}>
            {t('library.showWindow')}
          </button>
        </>
      );
    case 'stopping':
      return (
        <button type="button" className="button-primary" disabled>
          {t('library.stopping')}
        </button>
      );
    default: {
      const className = lead === undefined ? 'button-primary' : 'button-link';
      return controls.needsModel ? (
        <>
          {lead}
          <button type="button" className={className} onClick={controls.openModels}>
            {t('library.needsModel')}
          </button>
        </>
      ) : (
        <>
          {lead}
          <button type="button" className={className} onClick={controls.launch}>
            {t('library.launch')}
          </button>
          {secondary}
        </>
      );
    }
  }
}

/**
 * The latest launch of one Harness since the app started, followed live through `launch.status`
 * and `launch.state`; undefined while it has none.
 */
export function useLaunchStatus(harnessId: string): LaunchStatus | undefined {
  const [launch, setLaunch] = useState<LaunchStatus | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setLaunch(undefined);
    const unsubscribe = window.api.on('launch.state', (status) => {
      if (status.harnessId === harnessId) setLaunch(status);
    });
    void window.api.launch.status().then((result) => {
      if (!current || !result.ok) return;
      const status = result.data.find((each) => each.harnessId === harnessId);
      // An event that came first is newer than this answer.
      setLaunch((previous) => previous ?? status);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [harnessId]);
  return launch;
}
