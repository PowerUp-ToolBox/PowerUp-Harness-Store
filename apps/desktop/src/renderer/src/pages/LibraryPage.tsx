import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { InstalledHarness, IpcError, LaunchStatus } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LibraryIcon } from '../shell/icons.js';

/**
 * The Library (docs/ux/screens.md): one card per installed Harness, the most recently launched
 * first, then by name, as `installs.list` orders them. It reloads on `installs.changed`, and
 * follows each Harness's launch with `launch.status` and `launch.state`. P0-05 builds the basic
 * card (icon, name, Publisher, version, the Local badge, the primary button with its launch
 * states); P0-10 adds sort and filter, the overflow menu and update states.
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

/**
 * One installed Harness. Its primary button follows docs/ux/design-principles.md §3: Launch;
 * "Starting…" while it starts; "Running…" with "Show window" while it runs (both bring its
 * window to the front, as a second launch would); "Stopping…" after its window closed; "Set up a
 * model first", which opens the Models page at this Harness, when nothing can fill its `default`
 * Model Slot; "Not available for your platform", disabled.
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

  const start = async () => {
    setError(null);
    const result = await window.api.launch.start({ harnessId });
    if (!result.ok) {
      if (result.error.code === 'slot_unbound') setNeedsModel(true);
      else setError(result.error);
    }
  };
  const openModels = () => {
    void navigate(`/models?harness=${encodeURIComponent(harnessId)}`);
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
      </div>
      <div className="harness-card-actions">
        <PrimaryAction
          install={install}
          state={launch?.state}
          needsModel={needsModel}
          onStart={() => void start()}
          onOpenModels={openModels}
        />
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
    </article>
  );
}

function PrimaryAction({
  install,
  state,
  needsModel,
  onStart,
  onOpenModels,
}: {
  readonly install: InstalledHarness;
  readonly state: LaunchStatus['state'] | undefined;
  readonly needsModel: boolean;
  readonly onStart: () => void;
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
          <button type="button" className="button-primary" onClick={onStart}>
            {t('library.running')}
          </button>
          <button type="button" className="button-link" onClick={onStart}>
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
        <button type="button" className="button-primary" onClick={onStart}>
          {t('library.launch')}
        </button>
      );
  }
}
