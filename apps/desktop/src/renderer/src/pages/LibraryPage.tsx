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
import { LaunchAction, useLauncher } from '../library/LaunchAction.js';
import { LibraryIcon, MoreIcon } from '../shell/icons.js';

/**
 * The Library (docs/ux/screens.md): one card per installed Harness, the most recently launched
 * first, then by name, as `installs.list` orders them. It reloads on `installs.changed`, and
 * follows each Harness's launch with `launch.status` and `launch.state`, so every card shows its
 * Harness's state live, without polling. P0-05 builds the basic card (icon, name, Publisher,
 * version, the Local badge, the primary button with its launch states, the error line of a failed
 * launch) and its overflow menu's Model Overrides, Show logs and Open data folder; P0-09.3 adds
 * View in Store; P0-10 adds sort and filter, the menu's other items and update states.
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
 * One installed Harness: icon, name, Publisher, version, the Local badge, the primary button
 * ({@link LaunchAction}, shared with the Store detail page) and its overflow menu. A launch that
 * failed shows why ("Exited with an error", "Did not start in time", "Could not start") with Show
 * logs and Dismiss, and Launch retries; the paths Show logs and Open data folder open are computed
 * in main. View in Store opens the Harness's Store detail page, which says so when the Store no
 * longer has it.
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
  const [error, setError] = useState<IpcError | null>(null);
  const launcher = useLauncher(install, setError);
  const [, dismissed] = useReducer((count: number) => count + 1, 0);
  const { harnessId } = install;
  const failure =
    launch === undefined || dismissedFailures.has(launch.launchId) ? null : shownFailure(launch);

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
            {
              label: t('library.menu.viewInStore'),
              onSelect: () => {
                void navigate(`/store/h/${harnessId}`);
              },
            },
            { label: t('library.menu.overrides'), onSelect: launcher.openModels },
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
        <LaunchAction install={install} state={launch?.state} launcher={launcher} />
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
      {launcher.sheet}
    </article>
  );
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
