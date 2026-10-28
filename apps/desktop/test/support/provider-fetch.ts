/**
 * Stand-ins for the Node `fetch` the Runtime tests Connections and lists models with
 * (`RuntimeOptions.providerFetch`), so no test reaches a real Provider or uses a real key.
 */

/** No network: every call fails as a refused connection does. */
export const offlineProviderFetch: typeof globalThis.fetch = () =>
  Promise.reject(new TypeError('fetch failed'));

/**
 * Answers every Anthropic Messages call (a Connection test) with a 1-token reply, and anything
 * else with 404, without opening a socket.
 */
export const anthropicProviderFetch: typeof globalThis.fetch = (input) => {
  const url = new Request(input).url;
  if (!url.endsWith('/v1/messages')) return Promise.resolve(new Response(null, { status: 404 }));
  return Promise.resolve(
    Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    }),
  );
};
