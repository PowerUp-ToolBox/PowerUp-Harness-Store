import type { ModelRequirements } from '@harness-store/manifest';
import { useEffect, useState } from 'react';
import type { BindingTarget, ConnectionSummary, ModelInfo } from '../../../shared/ipc.js';
import { checkRequirements, type RequirementFailure } from '../../../shared/requirements.js';
import { useI18n, type I18n } from '../i18n/I18nProvider.js';

const ORDER: readonly RequirementFailure[] = ['tools', 'vision', 'json', 'minContext'];

const CAPABILITY_KEYS = {
  tools: 'models.requirements.tools',
  vision: 'models.requirements.vision',
  json: 'models.requirements.json',
} as const;

/** The names of `requirements` (all of them, or only those in `only`), in the checker's order. */
function requirementNames(
  { t, formatNumber }: I18n,
  requirements: ModelRequirements | undefined,
  only?: readonly RequirementFailure[],
): string[] {
  const asked = ORDER.filter(
    (name) =>
      (only === undefined || only.includes(name)) &&
      (name === 'minContext'
        ? requirements?.minContext !== undefined
        : requirements?.[name] === true),
  );
  return asked.map((name) =>
    name === 'minContext'
      ? t('models.requirements.min_context', {
          context: formatNumber(requirements?.minContext ?? 0),
        })
      : t(CAPABILITY_KEYS[name]),
  );
}

/** "Needs: tool calling and vision", or null for a Slot that asks for nothing. */
export function requirementsText(i18n: I18n, requirements: ModelRequirements | undefined) {
  const names = requirementNames(i18n, requirements);
  if (names.length === 0) return null;
  return i18n.t('models.requirements.needs', { requirements: i18n.formatList(names) });
}

export interface RequirementNoteProps {
  /** The Harness whose Slot it is, by its display name. */
  readonly harness: string;
  readonly slot: string;
  readonly requirements: ModelRequirements | undefined;
  /** What is known of the model the Slot uses; null while it is being looked up. */
  readonly model: ModelInfo | null;
}

/**
 * The Model Requirements check of one model for one Slot, shown under its binding control: a
 * yellow warning naming each requirement the model is known not to meet, else a muted note when
 * some cannot be checked (a model typed by hand or listed live), else nothing. Advisory only: the
 * binding is saved and used either way.
 */
export function RequirementNote({ harness, slot, requirements, model }: RequirementNoteProps) {
  const i18n = useI18n();
  if (model === null) return null;
  const check = checkRequirements(requirements, model);
  if (check.failures.length > 0) {
    return (
      <p className="requirement-warning" role="note">
        {i18n.t('models.requirements.warning', {
          harness,
          slot,
          capabilities: i18n.formatList(requirementNames(i18n, requirements, check.failures)),
        })}
      </p>
    );
  }
  if (check.unknown) {
    return (
      <p className="requirement-unknown" role="note">
        {i18n.t('models.requirements.unknown', { harness, slot })}
      </p>
    );
  }
  return null;
}

/**
 * What is known of the models of the enabled Connections (`connections.models`: the catalogue's
 * for Anthropic and Google, a live listing elsewhere), as a lookup: a model none of them lists is
 * just its name, with unknown capabilities; null while its Connection's listing is loading. A
 * failed listing counts as listing nothing.
 */
export function useModelInfo(
  connections: readonly ConnectionSummary[] | null,
): (target: BindingTarget) => ModelInfo | null {
  const enabledIds = (connections ?? [])
    .filter((connection) => connection.enabled)
    .map((connection) => connection.id)
    .join('\n');
  const [listed, setListed] = useState<Readonly<Record<string, readonly ModelInfo[]>>>({});

  useEffect(() => {
    let current = true;
    for (const connectionId of enabledIds === '' ? [] : enabledIds.split('\n')) {
      void window.api.connections.models(connectionId).then((result) => {
        if (!current) return;
        setListed((all) => ({ ...all, [connectionId]: result.ok ? result.data : [] }));
      });
    }
    return () => {
      current = false;
    };
  }, [enabledIds]);

  return ({ connectionId, model }) => {
    const enabled = enabledIds.split('\n').includes(connectionId);
    const models = listed[connectionId];
    if (enabled && models === undefined) return null;
    return models?.find((info) => info.id === model) ?? { id: model };
  };
}
