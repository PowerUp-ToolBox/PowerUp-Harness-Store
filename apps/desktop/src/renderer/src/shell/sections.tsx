import type { ReactNode } from 'react';
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
  readonly label: string;
  readonly icon: ReactNode;
}

/** The sidebar, in the order of docs/ux/design-principles.md §1. */
export const SECTIONS: readonly Section[] = [
  { path: '/library', label: 'Library', icon: <LibraryIcon /> },
  { path: '/store', label: 'Store', icon: <StoreIcon /> },
  { path: '/models', label: 'Models', icon: <ModelsIcon /> },
  { path: '/publish', label: 'Publish', icon: <PublishIcon /> },
  { path: '/usage', label: 'Usage', icon: <UsageIcon /> },
  { path: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

export function sectionFor(pathname: string): Section | undefined {
  return SECTIONS.find(
    (section) => pathname === section.path || pathname.startsWith(`${section.path}/`),
  );
}
