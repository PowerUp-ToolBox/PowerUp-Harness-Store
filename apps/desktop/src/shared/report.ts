/**
 * Pure rules of a Report (docs/ux/flows.md F8) that both processes share: the reasons, how the
 * optional contact email joins the details, and how long that text may be. The renderer uses them
 * for the dialog's counter and inline checks; the Runtime runs them again on every `store.report`,
 * since its input crossed a process boundary. No Node or DOM APIs, so both processes bundle it.
 */

/** The reasons of a Report: the `report_reason` enum of docs/tech/data-model.md, in its order. */
export const REPORT_REASONS = [
  'malware',
  'bypasses_gateway',
  'broken',
  'inappropriate',
  'spam',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** The longest `details` the Store's `report` function takes, the contact email included. */
export const REPORT_DETAILS_MAX_LENGTH = 2000;

/** The longest contact email (RFC 5321's path limit). */
export const CONTACT_EMAIL_MAX_LENGTH = 254;

/** Reports of one Harness this install may send in {@link REPORT_WINDOW_MS}. */
export const REPORTS_PER_HARNESS = 3;

/** The window of the client-side rate limit: 24 hours. */
export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isReportReason(value: unknown): value is ReportReason {
  return (REPORT_REASONS as readonly unknown[]).includes(value);
}

/**
 * Whether a typed contact email, trimmed, can be sent: empty (none), or something like `x@y` of
 * at most {@link CONTACT_EMAIL_MAX_LENGTH} characters with no whitespace. A loose check on
 * purpose: the Store never writes to it, a reviewer reads it.
 */
export function isContactEmail(email: string): boolean {
  const trimmed = email.trim();
  return (
    trimmed === '' ||
    (trimmed.length <= CONTACT_EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+$/.test(trimmed))
  );
}

/**
 * The `details` a Report sends: the contact email, when one was typed, first as
 * `Contact: <email>`, a blank line, then what the User wrote (P0 has no email column). Empty when
 * neither was typed; details of only whitespace count as none.
 */
export function reportDetails(details: string, contactEmail: string): string {
  const email = contactEmail.trim();
  const text = details.trim() === '' ? '' : details;
  if (email === '') return text;
  return text === '' ? `Contact: ${email}` : `Contact: ${email}\n\n${text}`;
}
