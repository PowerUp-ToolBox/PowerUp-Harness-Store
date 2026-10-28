import { describe, expect, it } from 'vitest';
import {
  initialWindowBounds,
  parseWindowState,
  type Rectangle,
  type WindowState,
} from '../src/main/runtime/window-state.js';

const PRIMARY: Rectangle = { x: 0, y: 25, width: 1920, height: 1055 };
const SECONDARY: Rectangle = { x: 1920, y: 0, width: 2560, height: 1440 };
const SAVED: WindowState = { x: 100, y: 120, width: 1100, height: 700, isMaximized: false };

describe('initialWindowBounds', () => {
  it('opens centred at 1280×800 when nothing was saved', () => {
    expect(initialWindowBounds(null, [PRIMARY])).toEqual({
      width: 1280,
      height: 800,
      isMaximized: false,
    });
  });

  it('restores the saved size and position when they are on a display', () => {
    expect(initialWindowBounds(SAVED, [PRIMARY])).toEqual(SAVED);
    const onSecondary = { ...SAVED, x: 2200, y: 300, isMaximized: true };
    expect(initialWindowBounds(onSecondary, [PRIMARY, SECONDARY])).toEqual(onSecondary);
  });

  it('centres at the default size when the saved display is gone', () => {
    const onSecondary = { ...SAVED, x: 2200, y: 300 };
    expect(initialWindowBounds(onSecondary, [PRIMARY])).toEqual({
      width: 1280,
      height: 800,
      isMaximized: false,
    });
  });

  it('never restores below the 960×640 minimum', () => {
    const tiny = { ...SAVED, width: 400, height: 300 };
    expect(initialWindowBounds(tiny, [PRIMARY])).toMatchObject({ width: 960, height: 640 });
  });

  it('shrinks a window saved on a larger display to fit the work area it reopens on', () => {
    const laptop: Rectangle = { x: 0, y: 0, width: 1440, height: 900 };
    const huge = { x: 0, y: 0, width: 2400, height: 1400, isMaximized: false };
    expect(initialWindowBounds(huge, [laptop])).toEqual({ ...laptop, isMaximized: false });
  });

  it('moves a window whose title bar would be above the work area back inside it', () => {
    // A monitor arranged above the primary was removed; the centre is still on the primary.
    const above = { ...SAVED, x: 200, y: -300, height: 800 };
    expect(initialWindowBounds(above, [PRIMARY])).toEqual({ ...above, y: PRIMARY.y });
  });

  it('moves a window that overhangs the right and bottom edges back inside the work area', () => {
    const overhang = { ...SAVED, x: 1300, y: 700 };
    expect(initialWindowBounds(overhang, [PRIMARY])).toEqual({
      ...overhang,
      x: PRIMARY.x + PRIMARY.width - SAVED.width,
      y: PRIMARY.y + PRIMARY.height - SAVED.height,
    });
  });

  it('keeps the minimum size on a work area smaller than it, pinned to the top-left corner', () => {
    const small: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    const saved = { ...SAVED, x: 50, y: 50, width: 700, height: 500 };
    expect(initialWindowBounds(saved, [small])).toEqual({
      x: 0,
      y: 0,
      width: 960,
      height: 640,
      isMaximized: false,
    });
  });
});

describe('parseWindowState', () => {
  it('accepts a well-formed state', () => {
    expect(parseWindowState(SAVED)).toEqual(SAVED);
  });

  it.each([
    null,
    'x',
    { ...SAVED, x: '1' },
    { ...SAVED, width: 0 },
    { ...SAVED, height: Number.NaN },
    { ...SAVED, y: 1.5 },
    { ...SAVED, isMaximized: 'no' },
  ])('rejects %j', (value) => {
    expect(parseWindowState(value)).toBeNull();
  });
});
