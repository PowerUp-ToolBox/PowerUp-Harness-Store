import type { ReactNode } from 'react';
import type { MessageKey } from '../../../shared/i18n/catalogs.js';
import {
  LibraryIcon,
  ModelsIcon,
  PublishIcon,
  SettingsIcon,
  StoreIcon,
  UsageIcon,
} from './icons.js';

export interface Section {
  /** The section's route; nested routes (`/store/h/…`) belong to the section too. */
  readonly path: string;
  /** The catalog key of the sidebar label, which is also the page title. */
  readonly labelKey: MessageKey;
  readonly icon: ReactNode;
}

/** The sidebar, in the order of docs/ux/design-principles.md §1. */
export const SECTIONS: readonly Section[] = [
  { path: '/library', labelKey: 'section.library', icon: <LibraryIcon /> },
  { path: '/store', labelKey: 'section.store', icon: <StoreIcon /> },
  { path: '/models', labelKey: 'section.models', icon: <ModelsIcon /> },
  { path: '/publish', labelKey: 'section.publish', icon: <PublishIcon /> },
  { path: '/usage', labelKey: 'section.usage', icon: <UsageIcon /> },
  { path: '/settings', labelKey: 'section.settings', icon: <SettingsIcon /> },
];

export function sectionFor(pathname: string): Section | undefined {
  return SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
}
