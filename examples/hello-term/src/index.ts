/**
 * hello-term: the reference Harness with UI Kind `terminal`. The Runtime starts it in a pty and
 * shows that pty in the Harness window, so stdin and stdout are its whole UI: a readline loop that
 * sends each message to the Model Gateway on the `default` Model Slot and prints the answer as it
 * streams in. It never sees a Provider or a credential, only the launch contract's Gateway URL and
 * Gateway Token (docs/tech/architecture.md §4), through `@harness-store/sdk`.
 *
 * Commands: `/model` prints the model each declared Slot is bound to right now, `/quit` exits with
 * code 0. End of input (Ctrl-D, or the end of piped stdin) and Ctrl-C do the same as `/quit`.
 */
import { createInterface } from 'node:readline';
import {
  createOpenAIClient,
  getContext,
  listSlots,
  NotInHarnessStoreError,
  Slots,
  SlotUnboundError,
} from '@harness-store/sdk';
import type { HarnessContext } from '@harness-store/sdk';
import { stringsFor } from './strings.js';
import type { Strings } from './strings.js';

/** One turn of the conversation, kept in memory for this session only. */
interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const write = (text: string) => process.stdout.write(text);

async function main(): Promise<number> {
  let context: HarnessContext;
  try {
    context = getContext();
  } catch (error) {
    // Started by hand rather than by Harness Store: say how to run it instead of failing on the
    // first Gateway call.
    if (!(error instanceof NotInHarnessStoreError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const strings = stringsFor(context.locale);
  const client = createOpenAIClient();
  const history: Message[] = [];

  write(`Hello Term ${context.harnessVersion}\n`);
  // `workspace: optional`: with a Workspace, say which folder this session works in; without one,
  // carry on (a Harness that needs files would keep them in its Data Directory instead).
  if (context.workspace !== undefined) write(`${strings.workspace(context.workspace)}\n`);
  write(`${strings.hint}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  // Ctrl-C or end of input may close the interface while an answer streams in; no prompt after.
  // They differ in what happens to lines already read: end of input (the end of piped stdin, or
  // Ctrl-D after typing ahead) still answers them in order, since the loop below drains them before
  // it ends by itself; Ctrl-C drops them and ends the session at once.
  const session = { closed: false, interrupted: false };
  let inFlight: AbortController | undefined;
  rl.on('close', () => {
    session.closed = true;
  });
  // Ctrl-C ends the session like /quit, also while an answer streams in.
  const interrupt = () => {
    session.interrupted = true;
    inFlight?.abort();
    rl.close();
  };
  rl.on('SIGINT', interrupt);
  process.once('SIGINT', interrupt);

  /** Sends `text` on the `default` Slot with the conversation so far and streams the answer. */
  const chat = async (text: string) => {
    history.push({ role: 'user', content: text });
    const controller = new AbortController();
    inFlight = controller;
    let reply = '';
    try {
      const stream = await client.chat.completions.create(
        { model: Slots.default, messages: history, stream: true },
        { signal: controller.signal },
      );
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta.content ?? '';
        reply += token;
        write(token);
      }
      write('\n');
      history.push({ role: 'assistant', content: reply });
    } catch (error) {
      // An unanswered message leaves the history as it was before it.
      history.pop();
      if (reply !== '') write('\n');
      if (!controller.signal.aborted) write(`${describe(error, strings)}\n`);
    } finally {
      inFlight = undefined;
    }
  };

  /** Prints `<slot> → <provider/model>` for every Model Slot the Manifest declares. */
  const showModels = async () => {
    try {
      for (const slot of await listSlots()) {
        write(`${slot.name} → ${slot.resolvedModel ?? strings.unbound}\n`);
      }
    } catch (error) {
      write(`${describe(error, strings)}\n`);
    }
  };

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (input === '/quit') break;
    if (input === '/model') await showModels();
    else if (input !== '') await chat(input);
    if (session.interrupted) break;
    // prompt() on a closed interface throws: past end of input, answer the lines left silently.
    if (!session.closed) rl.prompt();
  }
  rl.close();
  write(`${strings.bye}\n`);
  return 0;
}

/** A Gateway error as the User should read it: `slot_unbound` says where to bind a model. */
function describe(error: unknown, strings: Strings): string {
  const unbound = SlotUnboundError.from(error);
  if (unbound !== undefined) return strings.slotUnbound(unbound.slot || Slots.default);
  return strings.gatewayError(error instanceof Error ? error.message : String(error));
}

/** Exits once stdout and stderr have flushed, so piped output is never cut short. */
function exit(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

exit(await main());
