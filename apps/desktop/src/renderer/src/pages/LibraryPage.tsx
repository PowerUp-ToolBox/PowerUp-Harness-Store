import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type {
  InstalledHarness,
  IpcError,
  IpcResult,
  LaunchFailure,
  LaunchStatus,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { WorkspaceSheet } from '../library/WorkspaceSheet.js';
import { LibraryIcon, MoreIcon } from '../shell/icons.js';

/**
 * The Library (docs/ux/screens.md): one card per installed Harness, the most recently launched
 * first, then by name, as `installs.list` orders them. It reloads on `installs.changed`, and
 * follows each Harness's launch with `launch.status` and `launch.state`, so every card shows its
 * Harness's state live, without polling. P0-05 builds the basic card (icon, name, Publisher,
 * version, the Local badge, the primary button with its launch states, the error line of a failed
 * launch) and its overflow menu's Model Overrides, Show logs and Open data folder; P0-10 adds
 * sort and filter, the menu's other items and update states.
 */
export function LibraryPage() {
  const { t } = useI18n();
  const [installs, setInstalls] = useState<readonly InstalledHarness[] | null>(null);
  const [launches, setLaunches] = useState<ReadonlyMap<string, LaunchStatus>>(new Map());

  useEffect(() => {
    let current = true;
    const update = (status: LaunchStatus) => {
      setLaunches((previous) => new Map(previous).set(status.harnessId, status));
    };
    const unsubscribe = window.api.on('launch.state', update);
    void window.api.launch.status().then((result) => {
      if (current && result.ok) {
        setLaunches(new Map(result.data.map((status) => [status.harnessId, status])));
      }
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let current = true;
    const load = () => {
      void window.api.installs.list().then((result) => {
        if (current && result.ok) setInstalls(result.data);
      });
    };
    load();
    const unsubscribe = window.api.on('installs.changed', load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  if (installs === null) return null;
  if (installs.length === 0) {
    return (
      <div className="empty-panel library-empty">
        <LibraryIcon />
        <p className="empty-panel-title">{t('library.empty')}</p>
        <Link to="/store" className="button-primary">
          {t('library.empty.browse')}
        </Link>
      </div>
    );
  }
  return (
    <ul className="library-grid">
      {installs.map((install) => (
        <li key={install.harnessId}>
          <HarnessCard install={install} launch={launches.get(install.harnessId)} />
        </li>
      ))}
    </ul>
  );
}

/** The failures a card shows an error line for, by the `library.failed.*` copy of each. */
type ShownFailure = Extract<LaunchFailure, 'exit_nonzero' | 'ready_timeout' | 'spawn_error'>;

function shownFailure(launch: LaunchStatus | undefined): ShownFailure | null {
  if (launch?.state !== 'failed') return null;
  switch (launch.reason) {
    case 'exit_nonzero':
    case 'ready_timeout':
    case 'spawn_error':
      return launch.reason;
    default:
      // The User cancelled the Workspace picker, or the Harness does not run here: the card
      // simply offers Launch again.
      return null;
  }
}

/**
 * The launches whose error line the User dismissed. Renderer-only, and kept while the app runs,
 * so that leaving the Library and coming back does not show them again (docs/ux/flows.md F3:
 * "until dismissed").
 */
const dismissedFailures = new Set<string>();

/**
 * One installed Harness. Its primary button follows docs/ux/design-principles.md §3: Launch;
 * "Starting…" while it starts; "Running…" with "Show window" while it runs (both bring its
 * window to the front, as a second launch would); "Stopping…" after its window closed; "Set up a
 * model first", which opens the Models page at this Harness, when nothing can fill its `default`
 * Model Slot; "Not available for your platform", disabled. Launch first opens the Workspace sheet
 * for a Harness whose Manifest asks for a Workspace (docs/ux/flows.md F3). There is no Stop:
 * closing the Harness's window stops it with the shutdown sequence (flows.md F3 step 7).
 *
 * A launch that failed shows why ("Exited with an error", "Did not start in time", "Could not
 * start") with Show logs and Dismiss, and Launch retries; the paths Show logs and Open data
 * folder open are computed in main.
 */
function HarnessCard({
  install,
  launch,
}: {
  readonly install: InstalledHarness;
  readonly launch: LaunchStatus | undefined;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [needsModel, setNeedsModel] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [, dismissed] = useReducer((count: number) => count + 1, 0);
  const { harnessId } = install;
  const failure =
    launch === undefined || dismissedFailures.has(launch.launchId) ? null : shownFailure(launch);

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
  const startHere = () => {
    setError(null);
    void start().then(setError);
  };
  const launchFromCard = () => {
    if ((install.manifest.workspace ?? 'none') === 'none') startHere();
    else setChoosingWorkspace(true);
  };
  const openModels = () => {
    void navigate(`/models?harness=${encodeURIComponent(harnessId)}`);
  };
  /** Runs an "open in the OS" call, showing its error, if any, on the card. */
  const reveal = (call: (harnessId: string) => Promise<IpcResult<null>>) => {
    setError(null);
    void call(harnessId).then((result) => {
      if (!result.ok) setError(result.error);
    });
  };
  const showLogs = () => {
    reveal(window.api.launch.openLogs);
  };
  const dismiss = () => {
    if (launch !== undefined) dismissedFailures.add(launch.launchId);
    dismissed();
  };

  return (
    <article className="harness-card" aria-label={install.name}>
      <div className="harness-card-header">
        {install.iconDataUrl === null ? (
          <span className="harness-icon monogram" aria-hidden="true">
            {install.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className="harness-icon" src={install.iconDataUrl} alt="" />
        )}
        <div className="harness-card-text">
          <div className="harness-card-title">
            <h2 className="harness-card-name">{install.name}</h2>
            {install.source === 'local' ? (
              <span className="badge">{t('library.local')}</span>
            ) : null}
          </div>
          <p className="harness-card-subtitle">
            {t('library.card.subtitle', { publisher: install.publisher, version: install.version })}
          </p>
        </div>
        <CardMenu
          name={install.name}
          items={[
            { label: t('library.menu.overrides'), onSelect: openModels },
            { label: t('library.showLogs'), onSelect: showLogs },
            {
              label: t('library.menu.openDataFolder'),
              onSelect: () => {
                reveal(window.api.launch.openDataFolder);
              },
            },
          ]}
        />
      </div>
      {failure === null ? null : (
        <div className="harness-card-failure" role="alert">
          <span className="harness-card-failure-text">{t(`library.failed.${failure}`)}</span>
          <button type="button" className="button-link" onClick={showLogs}>
            {t('library.showLogs')}
          </button>
          <button type="button" className="button-link" onClick={dismiss}>
            {t('library.dismiss')}
          </button>
        </div>
      )}
      <div className="harness-card-actions">
        <PrimaryAction
          install={install}
          state={launch?.state}
          needsModel={needsModel}
          onLaunch={launchFromCard}
          onFocus={startHere}
          onOpenModels={openModels}
        />
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
      {choosingWorkspace ? (
        <WorkspaceSheet
          install={install}
          onLaunch={(workspace) => {
            setError(null);
            return start(workspace);
          }}
          onClose={() => {
            setChoosingWorkspace(false);
          }}
        />
      ) : null}
    </article>
  );
}

function PrimaryAction({
  install,
  state,
  needsModel,
  onLaunch,
  onFocus,
  onOpenModels,
}: {
  readonly install: InstalledHarness;
  readonly state: LaunchStatus['state'] | undefined;
  readonly needsModel: boolean;
  /** Launch: through the Workspace sheet when the Harness asks for a Workspace. */
  readonly onLaunch: () => void;
  /** Running… and Show window: a launch while it runs brings its window to the front. */
  readonly onFocus: () => void;
  readonly onOpenModels: () => void;
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
          <button type="button" className="button-primary" onClick={onFocus}>
            {t('library.running')}
          </button>
          <button type="button" className="button-link" onClick={onFocus}>
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
    default:
      return needsModel ? (
        <button type="button" className="button-primary" onClick={onOpenModels}>
          {t('library.needsModel')}
        </button>
      ) : (
        <button type="button" className="button-primary" onClick={onLaunch}>
          {t('library.launch')}
        </button>
      );
  }
}

interface CardMenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * A card's overflow menu: a three-dot button and the menu it opens under it. The first item gets
 * the focus; the arrow keys move between items; Escape closes it and gives the focus back to the
 * button, and so does choosing an item; a click elsewhere closes it.
 */
function CardMenu({
  name,
  items,
}: {
  /** The Harness's name, for the button's label. */
  readonly name: string;
  readonly items: readonly CardMenuItem[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    entries[(at + step + entries.length) % entries.length]?.focus();
  };

  return (
    <div className="card-menu" ref={container}>
      <button
        ref={button}
        type="button"
        className="card-menu-button"
        aria-label={t('library.menu', { name })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <MoreIcon />
      </button>
      {open ? (
        <div
          ref={menu}
          className="card-menu-list"
          role="menu"
          aria-label={t('library.menu', { name })}
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
