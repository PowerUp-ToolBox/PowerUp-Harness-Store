import { useEffect, useId, useRef, useState } from 'react';
import type {
  BindingSource,
  BindingTarget,
  ConnectionSummary,
  InstalledHarness,
  IpcError,
  ModelInfo,
  ModelOverride,
  ResolvedSlot,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMounted } from '../onboarding/use-mounted.js';
import { ModelPicker } from './ModelPicker.js';
import { connectionName } from './names.js';
import { RequirementNote, requirementsText, useModelInfo } from './requirements.js';

export interface HarnessOverridesSectionProps {
  /**
   * Changes after every change elsewhere on the page (a Connection, a Default Model), so the
   * cards resolve their Slots again.
   */
  readonly revision: number;
  /**
   * The Harness ID of the deep link `models?harness=<id>`: its card opens and scrolls into view.
   */
  readonly focusHarness: string | null;
}

/**
 * Per-Harness Overrides: one expandable card per installed Harness (as `installs.list` orders
 * them, read again on `installs.changed`), one row per Model Slot of its Manifest with the
 * Publisher's description, the Model Requirements, the Recommended Models, the model it resolves
 * to now with why ("Uses: Override", "Uses: Recommended", "Uses: Default"), a picker that sets the
 * Model Override at once, and "Clear override" while one is set. A requirement warning is
 * advisory: the override is saved and used either way.
 */
export function HarnessOverridesSection({ revision, focusHarness }: HarnessOverridesSectionProps) {
  const { t } = useI18n();
  const [installs, setInstalls] = useState<readonly InstalledHarness[] | null>(null);
  const [connections, setConnections] = useState<readonly ConnectionSummary[] | null>(null);
  const [installsRevision, setInstallsRevision] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(focusHarness === null ? [] : [focusHarness]),
  );
  const [error, setError] = useState<IpcError | null>(null);
  const modelInfo = useModelInfo(connections);

  useEffect(() => {
    if (focusHarness !== null) setExpanded((open) => new Set([...open, focusHarness]));
  }, [focusHarness]);

  useEffect(
    () =>
      window.api.on('installs.changed', () => {
        setInstallsRevision((current) => current + 1);
      }),
    [],
  );

  useEffect(() => {
    let current = true;
    void Promise.all([window.api.installs.list(), window.api.connections.list()]).then(
      ([installsResult, connectionsResult]) => {
        if (!current) return;
        setError(null);
        if (installsResult.ok) setInstalls(installsResult.data);
        else setError(installsResult.error);
        if (connectionsResult.ok) setConnections(connectionsResult.data);
        else setError(connectionsResult.error);
      },
    );
    return () => {
      current = false;
    };
  }, [revision, installsRevision]);

  const toggle = (harnessId: string) => {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(harnessId)) next.add(harnessId);
      return next;
    });
  };

  return (
    <section className="models-section" aria-labelledby="models-overrides">
      <div className="models-section-header">
        <h2 id="models-overrides">{t('models.overrides.title')}</h2>
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
      {installs === null || connections === null ? null : installs.length === 0 ? (
        <p className="hint">{t('models.overrides.empty')}</p>
      ) : (
        <ul className="override-cards">
          {installs.map((install) => (
            <li key={install.harnessId}>
              <HarnessCard
                install={install}
                connections={connections}
                revision={revision}
                expanded={expanded.has(install.harnessId)}
                focused={install.harnessId === focusHarness}
                onToggle={() => {
                  toggle(install.harnessId);
                }}
                modelInfo={modelInfo}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface HarnessCardProps {
  readonly install: InstalledHarness;
  readonly connections: readonly ConnectionSummary[];
  readonly revision: number;
  readonly expanded: boolean;
  /** Whether the deep link names it: it scrolls into view once shown. */
  readonly focused: boolean;
  readonly onToggle: () => void;
  readonly modelInfo: (target: BindingTarget) => ModelInfo | null;
}

function HarnessCard({
  install,
  connections,
  revision,
  expanded,
  focused,
  onToggle,
  modelInfo,
}: HarnessCardProps) {
  const { t } = useI18n();
  const ids = useId();
  const ref = useRef<HTMLElement>(null);
  const [resolved, setResolved] = useState<readonly ResolvedSlot[] | null>(null);
  const [overrides, setOverrides] = useState<readonly ModelOverride[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<IpcError | null>(null);
  const { harnessId } = install;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focused]);

  useEffect(() => {
    let current = true;
    void Promise.all([
      window.api.bindings.resolveAll(harnessId),
      window.api.bindings.getForHarness(harnessId),
    ]).then(([resolvedResult, overridesResult]) => {
      if (!current) return;
      setError(null);
      if (resolvedResult.ok) setResolved(resolvedResult.data);
      else setError(resolvedResult.error);
      if (overridesResult.ok) setOverrides(overridesResult.data);
      else setError(overridesResult.error);
    });
    return () => {
      current = false;
    };
  }, [harnessId, revision, reload, install.installedAt]);

  const slots = Object.keys(install.manifest.models.slots);
  const bodyId = `${ids}-slots`;
  return (
    <article ref={ref} className="override-card" aria-label={install.name}>
      <button
        type="button"
        className="override-card-toggle"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
      >
        {install.iconDataUrl === null ? (
          <span className="monogram override-card-icon" aria-hidden="true">
            {install.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className="override-card-icon" src={install.iconDataUrl} alt="" />
        )}
        <span className="override-card-name">{install.name}</span>
        <span className="override-card-count">
          {t('models.overrides.slots', { count: slots.length })}
        </span>
        <span className="override-card-caret" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>
      {expanded ? (
        <div id={bodyId}>
          {error === null ? null : <ErrorMessage error={error} />}
          {resolved === null ? null : (
            <ul className="override-rows">
              {resolved.map(({ slot, binding }) => (
                <SlotRow
                  key={slot}
                  install={install}
                  slot={slot}
                  binding={binding}
                  override={overrides.find((row) => row.slot === slot) ?? null}
                  connections={connections}
                  modelInfo={modelInfo}
                  onChanged={() => {
                    setReload((current) => current + 1);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}

const SOURCE_KEYS = {
  override: 'models.overrides.uses_override',
  recommended: 'models.overrides.uses_recommended',
  default_same_name: 'models.overrides.uses_default',
  default: 'models.overrides.uses_default',
} as const satisfies Record<BindingSource, string>;

interface SlotRowProps {
  readonly install: InstalledHarness;
  readonly slot: string;
  readonly binding: ResolvedSlot['binding'];
  readonly override: ModelOverride | null;
  readonly connections: readonly ConnectionSummary[];
  readonly modelInfo: (target: BindingTarget) => ModelInfo | null;
  /** After a saved change: the card resolves its Slots again. */
  readonly onChanged: () => void;
}

function SlotRow({
  install,
  slot,
  binding,
  override,
  connections,
  modelInfo,
  onChanged,
}: SlotRowProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const id = useId();
  const mounted = useMounted();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const declared = install.manifest.models.slots[slot];
  const needs = requirementsText(i18n, declared?.requirements);
  const recommended = declared?.recommended ?? [];

  const save = async (target: BindingTarget | null) => {
    setSaving(true);
    setError(null);
    const { harnessId } = install;
    const result =
      target === null
        ? await window.api.bindings.clearOverride({ harnessId, slot })
        : await window.api.bindings.setOverride({ harnessId, slot, target });
    if (!mounted.current) return;
    setSaving(false);
    if (result.ok) onChanged();
    else setError(result.error);
  };

  const connection =
    binding === null ? undefined : connections.find((item) => item.id === binding.connectionId);
  /** The Connection of an override that requests skip, as it is disabled. */
  const pausedConnection =
    override === null
      ? undefined
      : connections.find((item) => item.id === override.connectionId && !item.enabled);
  return (
    <li className="override-row" aria-busy={saving}>
      <div className="override-row-title">
        <code className="override-row-slot">{slot}</code>
        {declared?.description === undefined ? null : (
          <span className="override-row-description">{declared.description}</span>
        )}
      </div>
      {needs === null ? null : <p className="field-hint">{needs}</p>}
      {recommended.length === 0 ? null : (
        <p className="field-hint">
          {t('models.overrides.recommended', { models: recommended.join(', ') })}
        </p>
      )}
      <div className="override-row-resolved">
        {binding === null ? (
          <>
            <span className="override-row-model">{t('models.overrides.no_fill')}</span>
            <span className="status-chip" data-status="unbound">
              {t('models.overrides.unbound')}
            </span>
          </>
        ) : (
          <>
            <span className="override-row-model">
              {connection === undefined ? binding.connectionId : connectionName(t, connection)} ·{' '}
              {binding.model}
            </span>
            <span className="status-chip" data-status={binding.source}>
              {t(SOURCE_KEYS[binding.source])}
            </span>
          </>
        )}
      </div>
      <div className="override-row-controls">
        <ModelPicker
          id={id}
          label={t('models.overrides.picker', { slot })}
          connections={connections}
          value={
            override === null
              ? null
              : { connectionId: override.connectionId, model: override.model }
          }
          onChange={(choice) => void save(choice)}
          onClear={() => void save(null)}
          clearLabel={t('models.overrides.no_override')}
          disabled={saving}
        />
        {override === null ? null : (
          <button
            type="button"
            className="button-secondary"
            disabled={saving}
            onClick={() => void save(null)}
          >
            {t('models.overrides.clear')}
          </button>
        )}
      </div>
      {pausedConnection === undefined ? null : (
        <p className="default-model-warning" role="note">
          <span className="status-chip" data-status="warning">
            {t('models.defaults.connection_disabled')}
          </span>
          <span>
            {t('models.defaults.connection_disabled_hint', {
              name: connectionName(t, pausedConnection),
            })}
          </span>
        </p>
      )}
      {binding === null ? null : (
        <RequirementNote
          harness={install.name}
          slot={slot}
          requirements={declared?.requirements}
          model={modelInfo(binding)}
        />
      )}
      {error === null ? null : <ErrorMessage error={error} />}
    </li>
  );
}
