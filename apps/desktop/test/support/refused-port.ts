/**
 * A loopback port nothing listens on, for targets that must refuse the connection. Port 2 lies
 * below every OS's ephemeral range, so the fakes other test files start on port 0 at the same
 * time never land on it (a port the OS handed out and the test then closed can be handed out
 * again), and it is not on `fetch`'s blocked-port list, so the call is really refused
 * (ECONNREFUSED) rather than rejected as a bad port.
 */
export const REFUSED_PORT = 2;

/** An OpenAI base URL on {@link REFUSED_PORT}. */
export const REFUSED_BASE_URL = `http://127.0.0.1:${String(REFUSED_PORT)}/v1`;
