import { useState } from 'react';
import type { ConnectionSummary } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { ModelPicker, type ModelChoice } from '../models/ModelPicker.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

/** A model of one of the wizard's Connections, picked for the `default` Model Slot. */
export interface DefaultModelChoice {
  readonly connection: ConnectionSummary;
  readonly model: string;
}

export interface DefaultModelStepProps {
  readonly nav: WizardNav;
  /** The Connections this wizard run added: the picker offers only their models. */
  readonly connections: readonly ConnectionSummary[];
  /** What the User chose on an earlier visit to this step, if anything. */
  readonly choice: DefaultModelChoice | null;
  /** Continue keeps the picked model; Skip clears it (nothing is set). */
  readonly onChoose: (choice: DefaultModelChoice | null) => void;
}

/**
 * One model picker over the Connections added in this run, grouped by Connection, with "Type a
 * model name" for models a Provider does not list. It preselects the earlier choice, else the
 * first model a local Connection names, else the first a remote one names. With no Connection it
 * says the Default Model can be set later on the Models page.
 */
export function DefaultModelStep({ nav, connections, choice, onChoose }: DefaultModelStepProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ModelChoice | null>(() => {
    if (choice !== null) return { connectionId: choice.connection.id, model: choice.model };
    const first =
      connections.find((connection) => connection.local && connection.models.length > 0) ??
      connections.find((connection) => connection.models.length > 0);
    const model = first?.models[0];
    return first === undefined || model === undefined ? null : { connectionId: first.id, model };
  });

  const picked = (): DefaultModelChoice | null => {
    const connection = connections.find((item) => item.id === selected?.connectionId);
    return connection === undefined || selected === null
      ? null
      : { connection, model: selected.model };
  };

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.default.title')}</h1>
      {connections.length === 0 ? (
        <p className="wizard-panel">{t('onboarding.default.none')}</p>
      ) : (
        <>
          <p className="wizard-lead">{t('onboarding.default.hint')}</p>
          <div className="field">
            <label htmlFor="onboarding-default-model">{t('onboarding.default.model')}</label>
            <ModelPicker
              id="onboarding-default-model"
              connections={connections}
              value={selected}
              onChange={setSelected}
            />
          </div>
        </>
      )}
      <WizardActions
        nav={{
          ...nav,
          skip: () => {
            onChoose(null);
            nav.skip();
          },
        }}
        onPrimary={() => {
          onChoose(picked());
          nav.next();
        }}
      />
    </>
  );
}
