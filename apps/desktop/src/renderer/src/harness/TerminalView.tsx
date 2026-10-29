import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';

/** Lines kept above the screen. */
const SCROLLBACK = 5000;
/** Fixed until Settings has a terminal font size (P0-11). */
const FONT_SIZE = 13;

/**
 * The embedded terminal (xterm.js) of a terminal UI Kind Harness, filling the window. Once it is on
 * screen it reports its size (`terminal.ready`), and the Runtime starts the Harness in a pty of that
 * size, so no output comes before the terminal can show it. Output arrives as `terminal.data`;
 * keystrokes and size changes go back to the pty.
 *
 * Copy and paste: on macOS the app menu's Edit roles (Cmd+C, Cmd+V) act on xterm's own copy and
 * paste handling. On Windows and Linux, where Ctrl+C belongs to the Harness, Ctrl+Shift+C and
 * Ctrl+Shift+V copy the selection and paste through main's clipboard, as a sandboxed page has none.
 */
export function TerminalView({ name }: { readonly name: string }) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const style = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      fontFamily: style.getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: FONT_SIZE,
      scrollback: SCROLLBACK,
      cursorBlink: true,
      theme: { background: '#1b1c1f', foreground: '#ececee' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();

    const unsubscribe = window.harness.on('terminal.data', (data) => {
      terminal.write(data);
    });
    const input = terminal.onData((data) => {
      void window.harness.terminal.input(data);
    });
    const resized = terminal.onResize(({ cols, rows }) => {
      void window.harness.terminal.resize({ cols, rows });
    });
    if (!navigator.userAgent.includes('Mac')) {
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
        const key = event.key.toLowerCase();
        if (key === 'c') {
          if (terminal.hasSelection()) void window.harness.terminal.copy(terminal.getSelection());
          return false;
        }
        if (key === 'v') {
          void window.harness.terminal.paste().then((result) => {
            if (result.ok) terminal.paste(result.data);
          });
          return false;
        }
        return true;
      });
    }
    void window.harness.terminal.ready({ cols: terminal.cols, rows: terminal.rows });
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(element);
    terminal.focus();

    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      resized.dispose();
      terminal.dispose();
    };
  }, []);

  return (
    <div
      ref={container}
      className="harness-terminal"
      role="region"
      aria-label={t('harness.terminal', { name })}
    />
  );
}
