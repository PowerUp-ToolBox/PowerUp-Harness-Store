import type { Platform } from '@harness-store/manifest';
import type { ComponentType, ReactNode } from 'react';
import {
  harnessFacts,
  permissionItems,
  SEVERITY_LABEL,
  type PermissionSeverity,
  type TrustFacts,
} from '../../../shared/permissions.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { SeverityHighIcon, SeverityLowIcon, SeverityMediumIcon } from '../shell/icons.js';

const SEVERITY_ICON: Readonly<Record<PermissionSeverity, ComponentType>> = {
  low: SeverityLowIcon,
  medium: SeverityMediumIcon,
  high: SeverityHighIcon,
};

export interface TrustBlockProps {
  readonly facts: TrustFacts;
  /** Platform chips after the facts: the consent dialog lists the platforms there. */
  readonly platforms?: readonly Platform[];
  /** What the caller adds above the no-sandbox sentence, such as the consent dialog's ID line. */
  readonly children?: ReactNode;
}

/**
 * The trust block (docs/ux/design-principles.md §4), one component wherever a Harness asks for
 * trust, so the wording never diverges: the install consent dialog, the Publish screen's listing
 * preview, and the Store detail page (P0-09). It lists the Declared Permissions on the
 * low/medium/high scale, each with an icon, a label and a plain sentence (colour is never the only
 * signal), says they are declared and not enforced, then the facts row (runtime kind, UI Kind,
 * Workspace) and the standing no-sandbox sentence, unchanged.
 */
export function TrustBlock({ facts, platforms = [], children }: TrustBlockProps) {
  const { t } = useI18n();
  return (
    <div className="trust-block">
      <ul className="permission-list" aria-label={t('consent.permissions')}>
        {permissionItems(facts.permissions).map((item) => {
          const SeverityIcon = SEVERITY_ICON[item.severity];
          return (
            <li key={item.messageKey} className="permission-item" data-severity={item.severity}>
              <SeverityIcon />
              <span className="permission-text">
                <span className="permission-label">
                  {t(SEVERITY_LABEL[item.severity])} · {t(item.messageKey, item.params)}
                </span>
                {item.consequenceKey === undefined ? null : (
                  <span className="permission-consequence">{t(item.consequenceKey)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">{t('consent.informational')}</p>
      <ul className="fact-chips" aria-label={t('consent.facts')}>
        {harnessFacts(facts).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {platforms.map((platform) => (
          <li key={platform}>{platform}</li>
        ))}
      </ul>
      {children}
      <p className="no-sandbox">{t('consent.noSandbox')}</p>
    </div>
  );
}
