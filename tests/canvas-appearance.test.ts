import { expect, test } from 'vitest';
import {
  CANVAS_APPEARANCE_KEY,
  CANVAS_THEME_DEFAULTS,
  DEFAULT_CANVAS_APPEARANCE,
  canvasAppearanceDefaults,
  patternInk,
  readCanvasAppearance,
  saveCanvasAppearance,
  type CanvasAppearance,
} from '../renderer/src/canvas/canvas-appearance';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test('missing, corrupt or invalid stored appearances fall back per field', () => {
  const store = storage();
  expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);

  store.setItem(CANVAS_APPEARANCE_KEY, '{not json');
  expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);

  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({ pattern: 'grid', background: 'white', patternColor: '#abc', patternOpacity: 4 }));
  expect(readCanvasAppearance(store)).toEqual({ ...DEFAULT_CANVAS_APPEARANCE, patternOpacity: 1, inkCustomized: true });

  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({ pattern: 'lines', background: '#112233', patternColor: '#aabbcc', patternOpacity: -2 }));
  expect(readCanvasAppearance(store)).toEqual({
    pattern: 'lines', background: '#112233', patternColor: '#AABBCC', patternOpacity: 0,
    backgroundCustomized: true, inkCustomized: true,
  });
});

test('appearance round-trips through local storage', () => {
  const store = storage();
  const appearance: CanvasAppearance = {
    pattern: 'none',
    background: '#FFFFFF',
    patternColor: '#000000',
    patternOpacity: 0.4,
    backgroundCustomized: true,
    inkCustomized: true,
  };
  saveCanvasAppearance(store, appearance);
  expect(readCanvasAppearance(store)).toEqual(appearance);
});

test('untouched appearance follows the theme defaults', () => {
  const store = storage();
  expect(canvasAppearanceDefaults('clean')).toEqual({
    pattern: 'dots',
    background: '#FBFBFA',
    patternColor: '#37352F',
    patternOpacity: 0.22,
    backgroundCustomized: false,
    inkCustomized: false,
  });
  expect(readCanvasAppearance(store, 'clean')).toEqual(DEFAULT_CANVAS_APPEARANCE);
  expect(readCanvasAppearance(store, 'neumorphism').background).toBe(CANVAS_THEME_DEFAULTS.neumorphism.background);
  expect(DEFAULT_CANVAS_APPEARANCE.background).toBe('#FBFBFA');

  // Files written before the theme feature always carry the old soft-UI
  // defaults; they are treated as untouched rather than customized.
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', background: '#E8ECF1', patternColor: '#39434F', patternOpacity: 0.24,
  }));
  expect(readCanvasAppearance(store, 'clean')).toMatchObject({
    background: '#FBFBFA', patternColor: '#37352F', patternOpacity: 0.22,
    backgroundCustomized: false, inkCustomized: false,
  });
  expect(readCanvasAppearance(store, 'neumorphism')).toMatchObject({
    background: '#E8ECF1', patternColor: '#39434F', patternOpacity: 0.24,
  });
});

test('customized background and ink survive a theme change', () => {
  const store = storage();
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'lines', background: '#112233', patternColor: '#445566', patternOpacity: 0.5,
    backgroundCustomized: true, inkCustomized: true,
  }));
  expect(readCanvasAppearance(store, 'clean')).toEqual({
    pattern: 'lines', background: '#112233', patternColor: '#445566', patternOpacity: 0.5,
    backgroundCustomized: true, inkCustomized: true,
  });
  expect(readCanvasAppearance(store, 'neumorphism').background).toBe('#112233');
});

test('pattern ink is rgba with a clamped alpha', () => {
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: '#37352F', patternOpacity: 0.22 })).toBe('rgba(55, 53, 47, 0.22)');
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: '#ff0000', patternOpacity: 5 })).toBe('rgba(255, 0, 0, 1)');
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: 'nope', patternOpacity: 0.1 })).toBe('rgba(57, 67, 79, 0.1)');
});
