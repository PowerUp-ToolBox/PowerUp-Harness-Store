import type { InstalledHarness, IpcError, LaunchStatus } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LaunchAction, useLaunch } from '../library/LaunchAction.js';
import type { PrimaryActionState } from './primary-action.js';

/** A download in progress (P0-10): how far it is, and how to cancel it. */
export interface DetailDownload {
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
  readonly download?: DetailDownload | null;
  /** Install (flows F2). */
  readonly onInstall?: () => void;
  /** "Review and install": opens the consent dialog of the download again. */
  readonly onReview?: () => void;
  /** Update: P0-10.2 wires it (flows F4); until then a click does nothing. */
  readonly onUpdate?: () => void;
  /** A launch the Runtime refused, to show under the button; null when one begins. */
  readonly onError: (error: IpcError | null) => void;
}

/** What a button not wired yet does: nothing. */
const notYet = () => undefined;

/**
 * The primary button of a Store detail page and its secondary action, for each state of
 * {@link primaryActionState}. Launch is the Library's own button ({@link LaunchAction}), with its
 * Workspace sheet, "Set up a model first" and its Starting…, Running… and Stopping… states, so
 * launching from here and from the Library cannot differ; Uninstall, its secondary action, waits
 * for P0-10.3's uninstall and is disabled.
 */
export function DetailAction({
  state,
  install,
  launch,
  download = null,
  onInstall = notYet,
  onReview = notYet,
  onUpdate = notYet,
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
    case 'review':
      return (
        <button type="button" className="button-primary" onClick={onReview}>
          {t('store.detail.review')}
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
      onUpdate={onUpdate}
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
  onUpdate,
  onError,
}: {
  readonly update: boolean;
  readonly install: InstalledHarness;
  readonly launch: LaunchStatus | undefined;
  readonly onUpdate: () => void;
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
            <button type="button" className="button-primary" onClick={onUpdate}>
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
