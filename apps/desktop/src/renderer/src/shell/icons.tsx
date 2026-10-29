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

/** A check mark, for finished wizard steps and added Connections. */
export function CheckIcon() {
  return (
    <Icon>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  );
}

/** A padlock, beside the sentence saying where API keys are kept. */
export function LockIcon() {
  return (
    <Icon>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

/** A ticked circle: a low-severity Declared Permission. */
export function SeverityLowIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </Icon>
  );
}

/** A circle with an exclamation mark: a medium-severity Declared Permission. */
export function SeverityMediumIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6M12 16.5v.5" />
    </Icon>
  );
}

/** A warning triangle: a high-severity Declared Permission. */
export function SeverityHighIcon() {
  return (
    <Icon>
      <path d="M12 3l10 18H2L12 3z" />
      <path d="M12 10v5M12 18v.5" />
    </Icon>
  );
}

/** Three dots: a menu of more actions. */
export function MoreIcon() {
  return (
    <Icon>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Icon>
  );
}

/** GitHub's mark, filled, for Sign in with GitHub. */
export function GitHubIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z" />
    </svg>
  );
}

/** A folder with an arrow up, for the drop zone of the Publish screen. */
export function FolderUploadIcon() {
  return (
    <Icon>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      <path d="M12 10v6M9 13l3-3 3 3" />
    </Icon>
  );
}
