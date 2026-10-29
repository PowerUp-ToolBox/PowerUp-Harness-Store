import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcError, OwnHarness, OwnVersion, UnpublishedVersion } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { UnpublishDialog } from './UnpublishDialog.js';

/** What the list shows: loading at first, then the Harnesses or why they could not be read. */
type MineState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: IpcError }
  | { readonly kind: 'listed'; readonly harnesses: readonly OwnHarness[] };

/**
 * Refusals that mean the list on screen is out of date (the Harness or version was taken down,
 * is gone, or is no longer this Publisher's), so the list is read again behind the dialog.
 */
const STALE_LIST_CODES: ReadonlySet<IpcError['code']> = new Set([
  'harness_taken_down',
  'not_found',
  'forbidden',
]);

/** The version the Unpublish dialog is open for. */
interface Unpublishing {
  readonly harness: OwnHarness;
  readonly version: string;
}

/**
 * My Harnesses (docs/ux/screens.md, Publish; P0-08.3): every Harness the signed-in Publisher has
 * published, with its name, Harness ID, downloads and its status in the Store, and a table of all
 * its Harness Versions, newest first, each with its status (published, Unpublished with its date,
 * taken down with the administrator's note), when it was published and its downloads, as the
 * Store recorded them (`publish.myHarnesses`). It is read each time the tab opens, so a version
 * just published is there.
 *
 * A published version of a Harness that is not taken down can be Unpublished, after a
 * confirmation (./UnpublishDialog.tsx); the list then says so and is read again, which shows the
 * version's new status and the Harness's new current version. A refusal that shows the list is
 * out of date (a Takedown since it was read, say) reads it again too, so the stale row loses its
 * Unpublish. Unpublish needs the Store: offline it is off, with the reason.
 */
export function MyHarnesses() {
  const { t } = useI18n();
  const offline = useConnectivity().state === 'offline';
  const [state, setState] = useState<MineState>({ kind: 'loading' });
  const [unpublishing, setUnpublishing] = useState<Unpublishing | null>(null);
  const [done, setDone] = useState<{ name: string; version: string } | null>(null);
  const mounted = useRef(true);
  const reads = useRef(0);

  /** Reads the list; a list already shown stays until the new one arrives. */
  const load = useCallback(async () => {
    reads.current += 1;
    const read = reads.current;
    const result = await window.api.publish.myHarnesses();
    if (!mounted.current || read !== reads.current) return;
    setState(
      result.ok
        ? { kind: 'listed', harnesses: result.data }
        : { kind: 'error', error: result.error },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const retry = () => {
    setState({ kind: 'loading' });
    void load();
  };

  const unpublished = (harness: OwnHarness, result: UnpublishedVersion) => {
    setUnpublishing(null);
    setDone({ name: harness.name, version: result.version });
    void load();
  };

  return (
    <div className="publish-mine">
      {done === null ? null : (
        <p className="publish-mine-done" role="status">
          {t('publish.unpublish.done', { name: done.name, version: done.version })}
        </p>
      )}
      {offline ? (
        <p className="hint" role="note">
          {t('publish.mine.offline')}
        </p>
      ) : null}
      {state.kind === 'loading' ? (
        <p className="install-folder-status" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('publish.mine.loading')}
        </p>
      ) : state.kind === 'error' ? (
        <div className="publish-result">
          <ErrorMessage error={state.error} />
          <div className="publish-actions">
            <button type="button" className="button-secondary" onClick={retry}>
              {t('publish.mine.retry')}
            </button>
          </div>
        </div>
      ) : state.harnesses.length === 0 ? (
        <div className="empty-panel">
          <p>{t('publish.mine.empty')}</p>
        </div>
      ) : (
        state.harnesses.map((harness) => (
          <HarnessVersions
            key={harness.harnessId}
            harness={harness}
            offline={offline}
            busy={
              unpublishing?.harness.harnessId === harness.harnessId ? unpublishing.version : null
            }
            onUnpublish={(version) => {
              setDone(null);
              setUnpublishing({ harness, version });
            }}
          />
        ))
      )}
      {unpublishing === null ? null : (
        <UnpublishDialog
          harnessId={unpublishing.harness.harnessId}
          name={unpublishing.harness.name}
          version={unpublishing.version}
          onClose={() => {
            setUnpublishing(null);
          }}
          onUnpublished={(result) => {
            unpublished(unpublishing.harness, result);
          }}
          onRefused={(error) => {
            if (STALE_LIST_CODES.has(error.code)) void load();
          }}
        />
      )}
    </div>
  );
}

/** One Harness: its name, ID, downloads and Store status, then its versions. */
function HarnessVersions({
  harness,
  offline,
  busy,
  onUnpublish,
}: {
  readonly harness: OwnHarness;
  readonly offline: boolean;
  /** The version whose Unpublish dialog is open, if it is one of this Harness's. */
  readonly busy: string | null;
  readonly onUnpublish: (version: string) => void;
}) {
  const { t, formatNumber, formatDate } = useI18n();
  const takenDown = harness.storeStatus === 'taken_down';
  const titleId = `publish-mine-${harness.harnessId}`;
  return (
    <section className="publish-card publish-mine-harness" aria-labelledby={titleId}>
      <div className="publish-mine-head">
        <h2 id={titleId} className="publish-mine-name">
          {harness.name}
        </h2>
        <code className="publish-mine-id">{harness.harnessId}</code>
        <span className="hint">
          {t('publish.mine.downloads', { count: harness.downloadCount })}
        </span>
      </div>
      {harness.storeStatus === 'available' && harness.latestVersion !== null ? (
        <p className="hint">{t('publish.mine.latest', { version: harness.latestVersion })}</p>
      ) : harness.storeStatus === 'available' ? null : (
        <p className="warning-panel" role="note">
          {t(`publish.mine.harness.${harness.storeStatus}`)}
        </p>
      )}
      <table className="publish-mine-table">
        <caption className="visually-hidden">
          {t('publish.mine.versions', { name: harness.name })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('publish.mine.column.version')}</th>
            <th scope="col">{t('publish.mine.column.status')}</th>
            <th scope="col">{t('publish.mine.column.published')}</th>
            <th scope="col" className="publish-mine-number">
              {t('publish.mine.column.downloads')}
            </th>
            <th scope="col">
              <span className="visually-hidden">{t('publish.mine.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {harness.versions.map((version) => (
            <tr key={version.version}>
              <td>
                <code>{version.version}</code>
              </td>
              <td>
                <VersionStatusCell version={version} />
              </td>
              <td>{formatDate(Date.parse(version.publishedAt))}</td>
              <td className="publish-mine-number">{formatNumber(version.downloadCount)}</td>
              <td className="publish-mine-action">
                {version.status === 'published' && !takenDown ? (
                  <button
                    type="button"
                    className="button-secondary button-secondary-danger"
                    disabled={offline || busy === version.version}
                    aria-label={t('publish.unpublish.title', {
                      name: harness.name,
                      version: version.version,
                    })}
                    onClick={() => {
                      onUnpublish(version.version);
                    }}
                  >
                    {t('publish.unpublish')}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * A version's status, with the date it was Unpublished, or the administrator's note on a
 * taken-down one (only its Publisher ever sees it).
 */
function VersionStatusCell({ version }: { readonly version: OwnVersion }) {
  const { t, formatDate } = useI18n();
  return (
    <div className="publish-mine-status">
      <span className="status-chip" data-status={version.status}>
        {t(`publish.mine.status.${version.status}`)}
      </span>
      {version.status === 'unpublished' && version.unpublishedAt !== null ? (
        <span className="hint">
          {t('publish.mine.unpublishedAt', { date: formatDate(Date.parse(version.unpublishedAt)) })}
        </span>
      ) : null}
      {version.status === 'taken_down' && version.takedownNote !== null ? (
        <span className="publish-mine-note">
          {t('publish.mine.takedownNote', { note: version.takedownNote })}
        </span>
      ) : null}
    </div>
  );
}
