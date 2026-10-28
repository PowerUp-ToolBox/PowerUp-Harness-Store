import { diffForReconsent } from '@harness-store/manifest';
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
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
import { downloadPercent, useInstallJobs } from '../install/InstallJobsProvider.js';
import { isLaunchActive, LaunchAction, useLaunch } from '../library/LaunchAction.js';
import { UninstallDialog } from '../library/UninstallDialog.js';
import { LibraryIcon, MoreIcon, SearchIcon } from '../shell/icons.js';
import { ActionError, DownloadAction, UpdateButton } from '../store/DetailAction.js';

/** The Library's views (docs/ux/screens.md): every install, or those of one kind. */
const FILTERS = ['all', 'updates', 'running', 'local'] as const;
type LibraryFilter = (typeof FILTERS)[number];

/** The Library's orders: last launched first (then by name), or by name. */
type LibrarySort = 'recent' | 'name';

/**
 * The Library (docs/ux/screens.md): one card per installed Harness. It reloads on
 * `installs.changed`, and follows each Harness's launch with `launch.status` and `launch.state`,
 * so every card shows its Harness's state live, without polling. P0-05 builds the basic card
 * (icon, name, Publisher, version, the Local badge, the primary button with its launch states,
 * the error line of a failed launch) and its overflow menu's Model Overrides, Show logs and Open
 * data folder; P0-09.3 adds View in Store; P0-10.2 the update states; P0-10.3 Uninstall, the last
 * launched date and the controls above the cards.
 *
 * The controls narrow and order the list already loaded, in the renderer, with no call to main: a
 * name filter that narrows as the User types (case-insensitive, anywhere in the name), the views
 * All, Updates available, Running and Local installs, and the order Recently used (last launched
 * first, the never-launched after them, then by name) or Name. A view with no card says "No
 * Harnesses in this view", with Clear filters.
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

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [sort, setSort] = useState<LibrarySort>('recent');
  const sorted = useMemo(
    () => (installs === null ? [] : [...installs].sort(sort === 'name' ? byName : byRecentUse)),
    [installs, sort],
  );
  /** The Harness IDs the name filter and the view let through. */
  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    const passes = (install: InstalledHarness) => {
      if (words !== '' && !install.name.toLocaleLowerCase().includes(words)) return false;
      switch (filter) {
        case 'all':
          return true;
        case 'updates':
          return install.availableUpdate !== null;
        case 'running':
          return isLaunchActive(launches.get(install.harnessId));
        case 'local':
          return install.source === 'local';
      }
    };
    return new Set(sorted.filter(passes).map((install) => install.harnessId));
  }, [sorted, launches, query, filter]);

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
    <div className="library">
      <div className="library-controls">
        <div className="store-search library-filter">
          <SearchIcon />
          <input
            type="search"
            aria-label={t('library.filter')}
            placeholder={t('library.filter')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        <ul className="filter-chips" aria-label={t('library.views')}>
          {FILTERS.map((each) => (
            <li key={each}>
              <button
                type="button"
                className="filter-chip"
                aria-pressed={filter === each}
                onClick={() => {
                  setFilter(each);
                }}
              >
                {t(`library.view.${each}`)}
              </button>
            </li>
          ))}
        </ul>
        <select
          className="library-sort"
          aria-label={t('library.sort')}
          value={sort}
          onChange={(event) => {
            setSort(event.target.value === 'name' ? 'name' : 'recent');
          }}
        >
          <option value="recent">{t('library.sort.recent')}</option>
          <option value="name">{t('library.sort.name')}</option>
        </select>
      </div>
      {shown.size === 0 ? (
        <div className="empty-panel library-empty">
          <LibraryIcon />
          <p className="empty-panel-title">{t('library.emptyView')}</p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            {t('library.clearFilters')}
          </button>
        </div>
      ) : null}
      {/* A card the controls leave out is hidden, not removed, so it keeps its state and showing
          it again calls nothing in main. */}
      <ul className="library-grid" hidden={shown.size === 0}>
        {sorted.map((install) => (
          <li key={install.harnessId} hidden={!shown.has(install.harnessId)}>
            <HarnessCard install={install} launch={launches.get(install.harnessId)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** By name as the User reads it, then by ID for a stable order. */
function byName(a: InstalledHarness, b: InstalledHarness): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    (a.harnessId < b.harnessId ? -1 : a.harnessId > b.harnessId ? 1 : 0)
  );
}

/** Last launched first, the never-launched after them, then {@link byName}. */
function byRecentUse(a: InstalledHarness, b: InstalledHarness): number {
  if (a.lastLaunchedAt !== b.lastLaunchedAt) {
    if (a.lastLaunchedAt === null) return 1;
    if (b.lastLaunchedAt === null) return -1;
    return a.lastLaunchedAt < b.lastLaunchedAt ? 1 : -1;
  }
  return byName(a, b);
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
 * One installed Harness: icon, name, Publisher, version, the Local badge, when it was last
 * launched (nothing when it never was), the primary button ({@link LaunchAction}, shared with the
 * Store detail page) and its overflow menu: View in Store, Model Overrides, Show logs, Open data
 * folder and Uninstall, which opens the {@link UninstallDialog}. A launch that
 * failed shows why ("Exited with an error", "Did not start in time", "Could not start") with Show
 * logs and Dismiss, and Launch retries; the paths Show logs and Open data folder open are computed
 * in main. View in Store opens the Harness's Store detail page, which says so when the Store no
 * longer has it.
 *
 * An update the update check found (flows F4) leads the button: Update, or "Review update" when
 * it needs the User's consent again, with Launch as the secondary link; its download shows its
 * progress and Cancel in place of the button, and its failure under it. While the Harness runs
 * the button is the launch's, and the card says "Close the Harness to update". A Harness the
 * Store no longer offers (Unpublished or taken down) has the note "No longer available in the
 * Store" and no Update.
 */
function HarnessCard({
  install,
  launch,
}: {
  readonly install: InstalledHarness;
  readonly launch: LaunchStatus | undefined;
}) {
  const { t, formatDate } = useI18n();
  const navigate = useNavigate();
  const [error, setError] = useState<IpcError | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const controls = useLaunch(install, setError);
  const [, dismissed] = useReducer((count: number) => count + 1, 0);
  const installJobs = useInstallJobs();
  const { harnessId, availableUpdate } = install;
  const job = installJobs.jobs.get(harnessId);
  const running = isLaunchActive(launch);
  const noLongerInStore =
    install.storeStatus === 'unpublished' || install.storeStatus === 'taken_down';
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
            {/* The Publisher's Store page; one that is not in the Store says "No such Publisher". */}
            <Link className="harness-card-publisher" to={`/store/p/${install.publisher}`}>
              {install.publisher}
            </Link>
            <span aria-hidden="true"> · </span>
            {install.version}
          </p>
          {install.lastLaunchedAt === null ? null : (
            <p className="harness-card-subtitle">
              {t('library.lastLaunched', {
                date: formatDate(Date.parse(install.lastLaunchedAt)),
              })}
            </p>
          )}
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
            { label: t('library.menu.overrides'), onSelect: controls.openModels },
            { label: t('library.showLogs'), onSelect: showLogs },
            {
              label: t('library.menu.openDataFolder'),
              onSelect: () => {
                reveal(window.api.launch.openDataFolder);
              },
            },
            {
              label: t('library.menu.uninstall'),
              danger: true,
              onSelect: () => {
                setError(null);
                setUninstalling(true);
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
        {job?.kind === 'downloading' ? (
          <DownloadAction
            percent={downloadPercent(job)}
            onCancel={() => {
              installJobs.cancel(harnessId);
            }}
          />
        ) : (
          <LaunchAction
            install={install}
            state={launch?.state}
            controls={controls}
            lead={
              availableUpdate === null ? undefined : (
                <UpdateButton
                  reviewUpdate={
                    diffForReconsent(install.manifest, availableUpdate.manifest).required
                  }
                  onUpdate={() => {
                    setError(null);
                    installJobs.update(install, availableUpdate.manifest);
                  }}
                />
              )
            }
          />
        )}
      </div>
      {noLongerInStore ? <p className="hint">{t('store.detail.notInStore')}</p> : null}
      {availableUpdate !== null && running && job?.kind !== 'failed' ? (
        <p className="hint">{t('library.closeToUpdate')}</p>
      ) : null}
      {job?.kind === 'failed' ? <ActionError error={job.error} /> : null}
      {error === null ? null : <ErrorMessage error={error} />}
      {controls.sheet}
      {uninstalling ? (
        <UninstallDialog
          install={install}
          running={running}
          onClose={() => {
            setUninstalling(false);
          }}
        />
      ) : null}
    </article>
  );
}

interface CardMenuItem {
  readonly label: string;
  /** Shown in the danger colour: Uninstall. */
  readonly danger?: boolean;
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
              className={item.danger === true ? 'card-menu-danger' : undefined}
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
