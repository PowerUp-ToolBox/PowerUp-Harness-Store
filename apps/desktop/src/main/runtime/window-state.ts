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
 * window opens centred at the default size. The size never goes below the minimum.
 */
export function initialWindowBounds(
  saved: WindowState | null,
  workAreas: readonly Rectangle[],
): InitialWindowBounds {
  if (saved === null) return { ...DEFAULT_WINDOW_SIZE, isMaximized: false };
  const centreX = saved.x + saved.width / 2;
  const centreY = saved.y + saved.height / 2;
  const onDisplay = workAreas.some(
    (area) =>
      centreX >= area.x &&
      centreX < area.x + area.width &&
      centreY >= area.y &&
      centreY < area.y + area.height,
  );
  if (!onDisplay) return { ...DEFAULT_WINDOW_SIZE, isMaximized: saved.isMaximized };
  return {
    x: saved.x,
    y: saved.y,
    width: Math.max(saved.width, MIN_WINDOW_SIZE.width),
    height: Math.max(saved.height, MIN_WINDOW_SIZE.height),
    isMaximized: saved.isMaximized,
  };
}
