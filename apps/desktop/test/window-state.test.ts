import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppStateFile } from '../src/main/runtime/app-state-file.js';
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

describe('createAppStateFile', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-store-app-state-'));
    path = join(dir, 'app-state.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing file as empty', () => {
    expect(createAppStateFile(path).read()).toEqual({});
  });

  it('round-trips the window state across instances (an app restart)', () => {
    createAppStateFile(path).update({ windowState: SAVED });
    expect(createAppStateFile(path).read()).toEqual({ windowState: SAVED });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ windowState: SAVED });
  });

  it.each(['{not json', '[]', '{"windowState":{"x":1}}'])(
    'reads the corrupt or malformed file %j as empty',
    (content) => {
      writeFileSync(path, content);
      expect(createAppStateFile(path).read()).toEqual({});
    },
  );
});
