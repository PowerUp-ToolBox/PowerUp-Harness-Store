/**
 * Gateway logging. Logs carry metadata only (method, path, Harness ID, status, duration, ...),
 * never message content, Connection secrets or Gateway Tokens, and every string goes through
 * {@link redact} on the way out in case one slips into an error message.
 */

/** Where the Gateway writes its logs. Debug logs are request metadata; errors are Gateway bugs. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const REDACTED = '[redacted]';

/**
 * Hides credential-looking substrings: `Authorization` and `x-api-key` header values, Bearer
 * credentials and `sk-`-style API keys.
 */
export function redact(text: string): string {
  return text
    .replace(
      /\b(authorization|x-api-key)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',;]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[\w-]{8,}/g, REDACTED);
}

const SECRET_FIELD = /^(authorization|x-api-key|api[-_]?key|token|secret)$/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) return redact(value.stack ?? `${value.name}: ${value.message}`);
  if (depth > 4 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_FIELD.test(key) ? REDACTED : redactValue(item, depth + 1),
    ]),
  );
}

/**
 * Wraps `logger` so every message and field is redacted and a throwing logger never breaks a
 * request. Without a logger, debug logs are dropped and errors go to `console.error`.
 */
export function safeLogger(logger?: Logger): Logger {
  const target: Logger = logger ?? {
    debug() {
      // Debug logging is off unless a logger is given.
    },
    error(message, fields) {
      console.error(`[gateway] ${message}`, fields ?? '');
    },
  };
  const write = (level: keyof Logger, message: string, fields?: Record<string, unknown>) => {
    try {
      target[level](redact(message), fields && (redactValue(fields) as Record<string, unknown>));
    } catch {
      // Logging must never take a request down.
    }
  };
  return {
    debug: (message, fields) => {
      write('debug', message, fields);
    },
    error: (message, fields) => {
      write('error', message, fields);
    },
  };
}
