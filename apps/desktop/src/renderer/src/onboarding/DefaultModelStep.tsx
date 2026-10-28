import { useState } from 'react';
import type { ConnectionSummary } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
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
 * One picker over the models of the Connections added in this run, grouped by Connection,
 * preselecting the earlier choice, else the first local model, else the first remote one. With no
 * model to offer it says the Default Model can be set later on the Models page.
 */
export function DefaultModelStep({ nav, connections, choice, onChoose }: DefaultModelStepProps) {
  const { t } = useI18n();
  const choices = connections.flatMap((connection) =>
    connection.models.map((model) => ({ connection, model })),
  );
  const [selected, setSelected] = useState(() => {
    const earlier = choices.findIndex(
      (item) => item.connection.id === choice?.connection.id && item.model === choice.model,
    );
    if (earlier >= 0) return earlier;
    const local = choices.findIndex((item) => item.connection.local);
    return local >= 0 ? local : 0;
  });

  const picked = choices[selected];
  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.default.title')}</h1>
      {picked === undefined ? (
        <p className="wizard-panel">{t('onboarding.default.none')}</p>
      ) : (
        <>
          <p className="wizard-lead">{t('onboarding.default.hint')}</p>
          <div className="field">
            <label htmlFor="onboarding-default-model">{t('onboarding.default.model')}</label>
            <select
              id="onboarding-default-model"
              value={String(selected)}
              onChange={(event) => {
                setSelected(Number(event.target.value));
              }}
            >
              {connections.map((connection) => (
                <optgroup key={connection.id} label={connection.displayName}>
                  {choices.map((item, index) =>
                    item.connection === connection ? (
                      <option key={item.model} value={String(index)}>
                        {item.model}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ))}
            </select>
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
          onChoose(picked ?? null);
          nav.next();
        }}
      />
    </>
  );
}
