/**
 * Main window geometry: what is saved on close and how it is restored on the next launch.
 * Pure functions; src/main/index.ts reads the displays and the window from Electron.
 */

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState extends Rectangle {
  readonly isMaximized: boolean;
}

/** Bounds for the BrowserWindow constructor; no `x`/`y` means Electron centres the window. */
export interface InitialWindowBounds {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
export const MIN_WINDOW_SIZE = { width: 960, height: 640 } as const;

/** Returns the saved state when `value` is a well-formed one, else null (never throws). */
export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, width, height, isMaximized } = value as Record<string, unknown>;
  const integers = [x, y, width, height];
  if (!integers.every((n) => typeof n === 'number' && Number.isSafeInteger(n))) return null;
  if (typeof isMaximized !== 'boolean') return null;
  const state = { x, y, width, height, isMaximized } as WindowState;
  return state.width > 0 && state.height > 0 ? state : null;
}

/**
 * Where to open the main window. The saved bounds are reused when the window's centre is on one
 * of the current displays' work areas (a monitor may have been unplugged since); otherwise the
 * window opens centred at the default size. A reused window is shrunk to fit that work area and
 * moved fully inside it, so its title bar and resize corner stay reachable after a larger or
 * differently arranged display is removed. The size never goes below the minimum, even on a
 * work area smaller than that; the window is then pinned to the work area's top-left corner.
 */
export function initialWindowBounds(
  saved: WindowState | null,
  workAreas: readonly Rectangle[],
): InitialWindowBounds {
  if (saved === null) return { ...DEFAULT_WINDOW_SIZE, isMaximized: false };
  const centreX = saved.x + saved.width / 2;
  const centreY = saved.y + saved.height / 2;
  const area = workAreas.find(
    (a) => centreX >= a.x && centreX < a.x + a.width && centreY >= a.y && centreY < a.y + a.height,
  );
  if (area === undefined) return { ...DEFAULT_WINDOW_SIZE, isMaximized: saved.isMaximized };
  const width = Math.max(Math.min(saved.width, area.width), MIN_WINDOW_SIZE.width);
  const height = Math.max(Math.min(saved.height, area.height), MIN_WINDOW_SIZE.height);
  return {
    x: clamp(saved.x, area.x, area.x + area.width - width),
    y: clamp(saved.y, area.y, area.y + area.height - height),
    width,
    height,
    isMaximized: saved.isMaximized,
  };
}

/** `value` limited to [min, max]; `min` wins when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
