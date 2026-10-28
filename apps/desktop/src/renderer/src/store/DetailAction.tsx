import type { InstalledHarness, IpcError, LaunchStatus } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LaunchAction, useLaunch } from '../library/LaunchAction.js';
import type { PrimaryActionState } from './primary-action.js';

/** A download in progress (P0-10): how far it is, and how to cancel it. */
export interface DownloadProgress {
  /** 0 to 100. */
  readonly percent: number;
  readonly onCancel: () => void;
}

export interface DetailActionProps {
  /** From {@link primaryActionState}. */
  readonly state: PrimaryActionState;
  /** The installed Harness, if any: Launch and Update run it through the Library's launch controls. */
  readonly install: InstalledHarness | null;
  /** Its latest launch, for Starting…, Running… and Stopping…. */
  readonly launch: LaunchStatus | undefined;
  /** The download in progress, in the `downloading` state. */
  readonly download?: DownloadProgress | null;
  /** Install and Update: P0-10 wires them (flows F2 and F4); until then a click does nothing. */
  readonly onInstall?: () => void;
  /** A launch the Runtime refused, to show under the button; null when one begins. */
  readonly onError: (error: IpcError | null) => void;
}

/** What Install and Update do until P0-10 wires them: nothing. */
const noInstallYet = () => undefined;

/**
 * The primary button of a Store detail page and its secondary action, for each of the six states
 * of {@link primaryActionState}. Launch is the Library's own button ({@link LaunchAction}), with
 * its Workspace sheet, "Set up a model first" and its Starting…, Running… and Stopping… states, so
 * launching from here and from the Library cannot differ; Uninstall, its secondary action, waits
 * for P0-10's uninstall and is disabled.
 */
export function DetailAction({
  state,
  install,
  launch,
  download = null,
  onInstall = noInstallYet,
  onError,
}: DetailActionProps) {
  const { t } = useI18n();
  switch (state) {
    case 'downloading':
      return (
        <>
          <button type="button" className="button-primary download-button" disabled>
            <progress max={100} value={download?.percent ?? 0} aria-hidden="true" />
            {t('store.detail.downloading', { percent: Math.round(download?.percent ?? 0) })}
          </button>
          <button type="button" className="button-link" onClick={download?.onCancel}>
            {t('store.detail.cancel')}
          </button>
        </>
      );
    case 'removed':
      return (
        <button type="button" className="button-primary" disabled>
          {t('store.detail.removed')}
        </button>
      );
    case 'install':
      return (
        <button type="button" className="button-primary" onClick={onInstall}>
          {t('store.detail.install')}
        </button>
      );
    case 'unsupported':
      if (install !== null) break;
      return (
        <button type="button" className="button-primary" disabled>
          {t('library.unsupported')}
        </button>
      );
    case 'launch':
    case 'update':
      break;
  }
  return install === null ? null : (
    <InstalledAction
      update={state === 'update'}
      install={install}
      launch={launch}
      onInstall={onInstall}
      onError={onError}
    />
  );
}

/**
 * Launch (secondary: Uninstall), or Update (secondary: Launch), of an installed Harness. Both are
 * the Library's {@link LaunchAction}: with Update, its Launch (or "Set up a model first") becomes
 * the secondary link, and while the Harness starts, runs or stops it shows the Library's Starting…,
 * Running… or Stopping… in place of Update.
 */
function InstalledAction({
  update,
  install,
  launch,
  onInstall,
  onError,
}: {
  readonly update: boolean;
  readonly install: InstalledHarness;
  readonly launch: LaunchStatus | undefined;
  readonly onInstall: () => void;
  readonly onError: (error: IpcError | null) => void;
}) {
  const { t } = useI18n();
  const controls = useLaunch(install, onError);
  return (
    <>
      <LaunchAction
        install={install}
        state={launch?.state}
        controls={controls}
        lead={
          update ? (
            <button type="button" className="button-primary" onClick={onInstall}>
              {t('store.detail.update')}
            </button>
          ) : undefined
        }
        secondary={
          update ? undefined : (
            <button type="button" className="button-link" disabled>
              {t('store.detail.uninstall')}
            </button>
          )
        }
      />
      {controls.sheet}
    </>
  );
}
