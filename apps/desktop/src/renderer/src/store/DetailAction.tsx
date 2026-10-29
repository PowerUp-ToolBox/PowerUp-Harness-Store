import type { InstalledHarness, IpcError, LaunchStatus } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
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
  /** Update, and "Review update" (flows F4). */
  readonly onUpdate?: () => void;
  /** Uninstall, the secondary action of an installed Harness (flows F9). */
  readonly onUninstall?: () => void;
  /** A launch the Runtime refused, to show under the button; null when one begins. */
  readonly onError: (error: IpcError | null) => void;
}

/** What a button given no handler does: nothing. */
const nothing = () => undefined;

/**
 * The primary button of a Store detail page and its secondary action, for each state of
 * {@link primaryActionState}. Launch is the Library's own button ({@link LaunchAction}), with its
 * Workspace sheet, "Set up a model first" and its Starting…, Running… and Stopping… states, so
 * launching from here and from the Library cannot differ; Update and "Review update" lead it the
 * same way as on a Library card. Uninstall, the secondary action of Launch, opens the uninstall
 * confirmation (`onUninstall`).
 */
export function DetailAction({
  state,
  install,
  launch,
  download = null,
  onInstall = nothing,
  onReview = nothing,
  onUpdate = nothing,
  onUninstall = nothing,
  onError,
}: DetailActionProps) {
  const { t } = useI18n();
  switch (state) {
    case 'downloading':
      return <DownloadAction percent={download?.percent ?? 0} onCancel={download?.onCancel} />;
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
    case 'reviewUpdate':
      break;
  }
  return install === null ? null : (
    <InstalledAction
      update={state === 'update' || state === 'reviewUpdate' ? state : null}
      install={install}
      launch={launch}
      onUpdate={onUpdate}
      onUninstall={onUninstall}
      onError={onError}
    />
  );
}

/**
 * A download in progress (an install's or an update's): "Downloading 42%" with its progress bar,
 * and Cancel. The detail page's and the Library card's.
 */
export function DownloadAction({
  percent,
  onCancel,
}: {
  /** 0 to 100. */
  readonly percent: number;
  readonly onCancel: (() => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" className="button-primary download-button" disabled>
        <progress max={100} value={percent} aria-hidden="true" />
        {t('store.detail.downloading', { percent: Math.round(percent) })}
      </button>
      <button type="button" className="button-link" onClick={onCancel}>
        {t('store.detail.cancel')}
      </button>
    </>
  );
}

/**
 * Why the primary button's action failed, under the button: "Close the Harness to update" for an
 * update refused because the Harness runs (docs/ux/flows.md F4 step 3), else the Runtime's error.
 */
export function ActionError({ error }: { readonly error: IpcError }) {
  const { t } = useI18n();
  return error.code === 'harness_running' ? (
    <p className="error-message" role="alert">
      {t('library.closeToUpdate')}
    </p>
  ) : (
    <ErrorMessage error={error} />
  );
}

/**
 * The Update button of an installed Harness: Update, or "Review update" when the update needs the
 * User's consent again. It leads the Library's {@link LaunchAction} on the detail page and on a
 * Library card.
 */
export function UpdateButton({
  reviewUpdate,
  onUpdate,
}: {
  readonly reviewUpdate: boolean;
  readonly onUpdate: () => void;
}) {
  const { t } = useI18n();
  return (
    <button type="button" className="button-primary" onClick={onUpdate}>
      {t(reviewUpdate ? 'store.detail.reviewUpdate' : 'store.detail.update')}
    </button>
  );
}

/**
 * Launch (secondary: Uninstall), or Update or "Review update" (secondary: Launch), of an
 * installed Harness. Both are the Library's {@link LaunchAction}: with Update, its Launch (or
 * "Set up a model first") becomes the secondary link, and while the Harness starts, runs or stops
 * it shows the Library's Starting…, Running… or Stopping… in place of Update.
 */
function InstalledAction({
  update,
  install,
  launch,
  onUpdate,
  onUninstall,
  onError,
}: {
  readonly update: 'update' | 'reviewUpdate' | null;
  readonly install: InstalledHarness;
  readonly launch: LaunchStatus | undefined;
  readonly onUpdate: () => void;
  readonly onUninstall: () => void;
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
          update === null ? undefined : (
            <UpdateButton reviewUpdate={update === 'reviewUpdate'} onUpdate={onUpdate} />
          )
        }
        secondary={
          update !== null ? undefined : (
            <button type="button" className="button-link" onClick={onUninstall}>
              {t('store.detail.uninstall')}
            </button>
          )
        }
      />
      {controls.sheet}
    </>
  );
}
