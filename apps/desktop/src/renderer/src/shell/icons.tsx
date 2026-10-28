import type { ReactNode } from 'react';

/** Inline 24×24 stroke icons (no icon library), decorative: the label carries the meaning. */
function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function LibraryIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function StoreIcon() {
  return (
    <Icon>
      <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </Icon>
  );
}

export function ModelsIcon() {
  return (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </Icon>
  );
}

export function PublishIcon() {
  return (
    <Icon>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Icon>
  );
}

export function UsageIcon() {
  return (
    <Icon>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Icon>
  );
}

/** A crossed-out Wi-Fi signal, for the offline banner and panel. */
export function OfflineIcon() {
  return (
    <Icon>
      <path d="M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10 5.1M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.6M8.5 16.4a5 5 0 0 1 7 0M12 20h0M2 2l20 20" />
    </Icon>
  );
}
