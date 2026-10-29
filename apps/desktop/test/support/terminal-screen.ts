import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

/**
 * What a pty printed, rendered as the Harness window's xterm.js renders it, by xterm.js itself
 * (headless). On macOS and Linux the pty passes a Harness's bytes through; Windows' ConPTY instead
 * draws its screen again, with cursor moves for line breaks and erases for blanks, so only the
 * rendered screen reads the same on every OS.
 */
export interface TerminalScreen {
  /** Feeds what the pty printed. */
  write(data: string): void;
  /** Resizes the terminal, as the window's xterm.js does before it sends the pty its new size. */
  resize(size: { cols: number; rows: number }): void;
  /**
   * The text on screen and in the scrollback once everything written so far is rendered: one line
   * per line the Harness printed (a row it ran past the edge of joins the next), without blanks at
   * the end of a line, and without the empty rows below the last one written.
   */
  text(): Promise<string>;
}

export function createTerminalScreen(size: { cols: number; rows: number }): TerminalScreen {
  // The buffer that is read back is a proposed API of the headless build.
  const terminal = new Terminal({ ...size, scrollback: 10_000, allowProposedApi: true });
  return {
    write(data) {
      terminal.write(data);
    },
    resize(size) {
      terminal.resize(size.cols, size.rows);
    },
    async text() {
      await new Promise<void>((resolve) => {
        terminal.write('', resolve);
      });
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (line === undefined) continue;
        // Untrimmed, so a blank at the edge of a row the next one continues is kept.
        const text = line.translateToString(false);
        const last = lines.length - 1;
        if (line.isWrapped && last >= 0) lines[last] = `${lines[last] ?? ''}${text}`;
        else lines.push(text);
      }
      const trimmed = lines.map((each) => each.trimEnd());
      while (trimmed.at(-1) === '') trimmed.pop();
      return trimmed.join('\n');
    },
  };
}

/** The terminals of several Harness windows, one {@link TerminalScreen} per launch. */
export function createTerminalScreens(size: { cols: number; rows: number }) {
  const screens = new Map<string, TerminalScreen>();
  const screenOf = (launchId: string): TerminalScreen => {
    let screen = screens.get(launchId);
    if (screen === undefined) {
      screen = createTerminalScreen(size);
      screens.set(launchId, screen);
    }
    return screen;
  };
  return {
    /** Feeds what the pty of `launchId` printed. */
    write(launchId: string, data: string) {
      screenOf(launchId).write(data);
    },
    /** Resizes the terminal of `launchId`'s window. */
    resize(launchId: string, next: { cols: number; rows: number }) {
      screenOf(launchId).resize(next);
    },
    /** The text of `launchId`'s terminal; empty before its pty printed anything. */
    async text(launchId: string): Promise<string> {
      return (await screens.get(launchId)?.text()) ?? '';
    },
  };
}
