import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectionSummary,
  InstalledHarness,
  IpcError,
  UsageDimension,
  UsageFilter,
  UsageRow,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useToast } from '../components/Toasts.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { connectionName, providerName } from '../models/names.js';
import { ClearUsageDialog } from '../usage/ClearUsageDialog.js';
import { useUsageRecorded } from '../usage/live-refresh.js';
import { localDay, periodStart, USAGE_PERIODS, type UsagePeriod } from '../usage/period.js';

/** Everything the page shows, each part one `usage.query` summed in SQL. */
interface UsageView {
  /** The period and filters' total (`[]`). */
  readonly total: UsageRow;
  /** One row per Harness (`['harness']`), most recently used first. */
  readonly harnesses: readonly UsageRow[];
  /** One row per Harness, Provider and model (`['harness', 'model']`), most recently used first. */
  readonly models: readonly UsageRow[];
  /** One row per local day that has records (`['day']`), newest first. */
  readonly days: readonly UsageRow[];
  /** Every Harness that has records, of all time and unfiltered: the Harness filter's options. */
  readonly harnessOptions: readonly UsageRow[];
  /** Every Provider that has records, of all time and unfiltered: the Provider filter's options. */
  readonly providerOptions: readonly UsageRow[];
}

/** One answer of `usage.query`. */
type Rows = readonly UsageRow[];

/** What the page names Harnesses and Providers by. */
interface Names {
  readonly installs: readonly InstalledHarness[];
  readonly connections: readonly ConnectionSummary[];
}

/**
 * The Usage page (docs/ux/flows.md F7, docs/ux/screens.md): tokens used through the Model Gateway
 * on this machine, from its Usage Records. A period (Today, 7 days by default, 30 days, All, in
 * the User's local days), totals (requests, errors, prompt and completion tokens), a table by
 * Harness then by model with the last use, a daily breakdown, filters by Harness and by Provider,
 * Export CSV and Clear usage data. It says that Usage Records never leave the machine, and shows
 * tokens only: no cost.
 *
 * Every number is summed in SQL by `usage.query`; the page only formats. A token count reads "—"
 * with the tooltip "This Provider did not report usage" when no `ok` request of its row reported
 * one, and the known sum followed by that mark when some did not; failed requests are counted
 * under Errors and never in token sums. While the page is shown it queries again when the Model
 * Gateway writes a record (`usage.recorded`), at most every 2 seconds. With no Usage Record at
 * all it shows "Launch a Harness to see usage here".
 */
export function UsagePage() {
  const { t } = useI18n();
  const toast = useToast();
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const [harnessId, setHarnessId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [view, setView] = useState<UsageView | null>(null);
  /** Why the last load failed; the next load that succeeds clears it. */
  const [error, setError] = useState<IpcError | null>(null);
  /**
   * Why the last Export CSV failed. Kept apart from `error` so a live refresh, which may load
   * again within 2 seconds, never hides it: only the next export clears it.
   */
  const [exportError, setExportError] = useState<IpcError | null>(null);
  const [names, setNames] = useState<Names>({ installs: [], connections: [] });
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Only the latest load may show its answer. */
  const loads = useRef(0);

  useEffect(() => {
    let current = true;
    void Promise.all([window.api.installs.list(), window.api.connections.list()]).then(
      ([installs, connections]) => {
        if (!current) return;
        setNames({
          installs: installs.ok ? installs.data : [],
          connections: connections.ok ? connections.data : [],
        });
      },
    );
    return () => {
      current = false;
    };
  }, []);

  /** The period, computed from now, and the filters, as `usage.query` and `usage.export` take them. */
  const filterNow = useCallback(
    (): UsageFilter => ({
      from: periodStart(period, new Date()),
      to: null,
      ...(harnessId === '' ? {} : { harnessId }),
      ...(providerId === '' ? {} : { providerId }),
    }),
    [period, harnessId, providerId],
  );

  const load = useCallback(() => {
    const load = ++loads.current;
    const filter = filterNow();
    const run = (groupBy: readonly UsageDimension[], all = false) =>
      window.api.usage.query(all ? { from: null, to: null, groupBy } : { ...filter, groupBy });
    void Promise.all([
      run([]),
      run(['harness']),
      run(['harness', 'model']),
      run(['day']),
      run(['harness'], true),
      run(['provider'], true),
    ]).then((results) => {
      if (load !== loads.current) return;
      for (const result of results) {
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      const [total, harnesses, models, days, harnessOptions, providerOptions] = results.map(
        (result) => (result.ok ? result.data : []),
      ) as [Rows, Rows, Rows, Rows, Rows, Rows];
      const [totalRow] = total;
      if (totalRow === undefined) return;
      setError(null);
      setView({ total: totalRow, harnesses, models, days, harnessOptions, providerOptions });
    });
  }, [filterNow]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () => () => {
      // An answer arriving after the page closed is dropped.
      loads.current += 1;
    },
    [],
  );
  useUsageRecorded(load);

  const harnessName = (id: string) =>
    names.installs.find((install) => install.harnessId === id)?.name ?? id;
  const providerLabel = (id: string) => {
    const connection = names.connections.find((each) => each.id === id);
    return connection === undefined ? providerName(t, id, id) : connectionName(t, connection);
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    const result = await window.api.usage.export(filterNow());
    setExporting(false);
    if (!result.ok) {
      setExportError(result.error);
      return;
    }
    if (result.data !== null) {
      const file = result.data.path.split(/[\\/]/).at(-1) ?? result.data.path;
      toast(t('usage.exported', { file }));
    }
  };

  const header = (
    <div className="usage-head">
      <p className="hint">{t('usage.note')}</p>
      <div className="segmented" role="group" aria-label={t('usage.period')}>
        {USAGE_PERIODS.map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={period === each}
            onClick={() => {
              setPeriod(each);
            }}
          >
            {t(`usage.period.${each}`)}
          </button>
        ))}
      </div>
    </div>
  );

  if (view === null) {
    return (
      <div className="usage">
        {header}
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    );
  }
  if (view.harnessOptions.length === 0) {
    return (
      <div className="usage">
        {header}
        <div className="empty-panel usage-empty">
          <p className="empty-panel-title">{t('usage.empty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="usage">
      {header}
      <dl className="usage-totals" aria-label={t('usage.totals')}>
        <div className="usage-tile">
          <dt>{t('usage.requests')}</dt>
          <dd>
            <Count value={view.total.requests} />
          </dd>
        </div>
        <div className="usage-tile">
          <dt>{t('usage.errors')}</dt>
          <dd>
            <Count value={view.total.errors} />
          </dd>
        </div>
        <div className="usage-tile">
          <dt>{t('usage.promptTokens')}</dt>
          <dd>
            <Tokens row={view.total} value={view.total.promptTokens} />
          </dd>
        </div>
        <div className="usage-tile">
          <dt>{t('usage.completionTokens')}</dt>
          <dd>
            <Tokens row={view.total} value={view.total.completionTokens} />
          </dd>
        </div>
      </dl>
      <div className="usage-controls">
        <select
          aria-label={t('usage.filter.harness')}
          value={harnessId}
          onChange={(event) => {
            setHarnessId(event.target.value);
          }}
        >
          <option value="">{t('usage.filter.allHarnesses')}</option>
          {view.harnessOptions.map((row) => (
            <option key={row.harnessId} value={row.harnessId}>
              {harnessName(row.harnessId ?? '')}
            </option>
          ))}
        </select>
        <select
          aria-label={t('usage.filter.provider')}
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
          }}
        >
          <option value="">{t('usage.filter.allProviders')}</option>
          {view.providerOptions.map((row) => (
            <option key={row.provider} value={row.provider}>
              {providerLabel(row.provider ?? '')}
            </option>
          ))}
        </select>
        <span className="usage-controls-gap" />
        <button
          type="button"
          className="button-secondary"
          disabled={exporting}
          onClick={() => void exportCsv()}
        >
          {t('usage.export')}
        </button>
        <button
          type="button"
          className="button-secondary button-secondary-danger"
          onClick={() => {
            setClearing(true);
          }}
        >
          {t('usage.clear')}
        </button>
      </div>
      {exportError === null ? null : <ErrorMessage error={exportError} />}
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="usage-table-frame">
        <table className="usage-table" aria-label={t('usage.byHarness')}>
          <thead>
            <tr>
              <th scope="col">{t('usage.column.harnessModel')}</th>
              <th scope="col" className="usage-number">
                {t('usage.requests')}
              </th>
              <th scope="col" className="usage-number">
                {t('usage.errors')}
              </th>
              <th scope="col" className="usage-number">
                {t('usage.promptTokens')}
              </th>
              <th scope="col" className="usage-number">
                {t('usage.completionTokens')}
              </th>
              <th scope="col">{t('usage.lastUsed')}</th>
            </tr>
          </thead>
          <tbody>
            {view.harnesses.flatMap((harness) => [
              <UsageTableRow
                key={harness.harnessId}
                kind="harness"
                row={harness}
                label={harnessName(harness.harnessId ?? '')}
              />,
              ...view.models
                .filter((model) => model.harnessId === harness.harnessId)
                .map((model) => (
                  <UsageTableRow
                    key={`${String(model.harnessId)}\n${String(model.provider)}\n${String(model.model)}`}
                    kind="model"
                    row={model}
                    label={model.model ?? ''}
                    detail={t('usage.via', { provider: providerLabel(model.provider ?? '') })}
                  />
                )),
            ])}
          </tbody>
        </table>
      </div>
      <section className="usage-daily" aria-labelledby="usage-daily">
        <h2 id="usage-daily">{t('usage.daily')}</h2>
        <div className="usage-table-frame">
          <table className="usage-table" aria-labelledby="usage-daily">
            <thead>
              <tr>
                <th scope="col">{t('usage.column.day')}</th>
                <th scope="col" className="usage-number">
                  {t('usage.requests')}
                </th>
                <th scope="col" className="usage-number">
                  {t('usage.errors')}
                </th>
                <th scope="col" className="usage-number">
                  {t('usage.promptTokens')}
                </th>
                <th scope="col" className="usage-number">
                  {t('usage.completionTokens')}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.days.map((day) => (
                <DayRow key={day.day} row={day} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {clearing ? (
        <ClearUsageDialog
          onClose={() => {
            setClearing(false);
          }}
          onCleared={() => {
            setHarnessId('');
            setProviderId('');
            load();
          }}
        />
      ) : null}
    </div>
  );
}

/** A Harness's subtotal row, or one of its models' rows under it. */
function UsageTableRow({
  kind,
  row,
  label,
  detail,
}: {
  readonly kind: 'harness' | 'model';
  readonly row: UsageRow;
  readonly label: string;
  readonly detail?: string;
}) {
  const { formatDate } = useI18n();
  return (
    <tr className={`usage-row-${kind}`}>
      <th scope="row">
        {kind === 'model' ? <code>{label}</code> : label}
        {detail === undefined ? null : (
          <>
            {' '}
            <span className="usage-row-detail">{detail}</span>
          </>
        )}
      </th>
      <td className="usage-number">
        <Count value={row.requests} />
      </td>
      <td className="usage-number">
        <Count value={row.errors} />
      </td>
      <td className="usage-number">
        <Tokens row={row} value={row.promptTokens} />
      </td>
      <td className="usage-number">
        <Tokens row={row} value={row.completionTokens} />
      </td>
      <td>
        {row.lastUsedAt === null
          ? null
          : formatDate(new Date(row.lastUsedAt), { dateStyle: 'medium', timeStyle: 'short' })}
      </td>
    </tr>
  );
}

/** One local day of the daily breakdown. */
function DayRow({ row }: { readonly row: UsageRow }) {
  const { formatDate } = useI18n();
  return (
    <tr>
      <th scope="row">{row.day === undefined ? null : formatDate(localDay(row.day))}</th>
      <td className="usage-number">
        <Count value={row.requests} />
      </td>
      <td className="usage-number">
        <Count value={row.errors} />
      </td>
      <td className="usage-number">
        <Tokens row={row} value={row.promptTokens} />
      </td>
      <td className="usage-number">
        <Tokens row={row} value={row.completionTokens} />
      </td>
    </tr>
  );
}

function Count({ value }: { readonly value: number }) {
  const { formatNumber } = useI18n();
  return <>{formatNumber(value)}</>;
}

/**
 * A token sum of `row`. When no `ok` request of the row reported its counts, a bare "—"; when
 * some did not, the known sum and a "—" mark; either way with "This Provider did not report
 * usage". Never a 0 that stands for missing data.
 */
function Tokens({ row, value }: { readonly row: UsageRow; readonly value: number }) {
  const { t, formatNumber } = useI18n();
  const unknown = (
    <span
      className="usage-unknown"
      role="img"
      aria-label={t('usage.unknown')}
      title={t('usage.unknown')}
    >
      —
    </span>
  );
  if (row.unknownCount === 0) return <>{formatNumber(value)}</>;
  if (row.requests - row.errors - row.unknownCount === 0) return unknown;
  return (
    <>
      {formatNumber(value)} {unknown}
    </>
  );
}
