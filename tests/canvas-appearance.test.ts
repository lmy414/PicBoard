import { expect, test } from 'vitest';
import {
  CANVAS_APPEARANCE_KEY,
  DEFAULT_CANVAS_APPEARANCE,
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

test('missing or corrupt appearances fall back to the default look', () => {
  const store = storage();
  expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);

  store.setItem(CANVAS_APPEARANCE_KEY, '{not json');
  expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);
});

test('invalid fields fall back without discarding the valid ones', () => {
  const store = storage();
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'grid', background: 'white', patternColor: '#abc', patternOpacity: 4,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    patternOpacity: 1,
    inkCustomized: true,
  });
});

test('ink values are preserved field by field when only one is usable', () => {
  const store = storage();
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', patternColor: '#aabbcc',
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    patternColor: '#AABBCC',
    inkCustomized: true,
  });

  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', patternColor: '#abc', patternOpacity: 0.33,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    patternOpacity: 0.33,
    inkCustomized: true,
  });
});

test('custom values are normalized and clamped', () => {
  const store = storage();
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'lines', background: '#112233', patternColor: '#aabbcc', patternOpacity: -2,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    pattern: 'lines', background: '#112233', patternColor: '#AABBCC', patternOpacity: 0,
    backgroundCustomized: true, inkCustomized: true,
  });
});

test('appearance round-trips through local storage', () => {
  const store = storage();
  const appearance: CanvasAppearance = {
    pattern: 'none',
    background: '#102030',
    patternColor: '#405060',
    patternOpacity: 0.4,
    backgroundCustomized: true,
    inkCustomized: true,
  };
  saveCanvasAppearance(store, appearance);
  expect(readCanvasAppearance(store)).toEqual(appearance);
});

test('explicitly untouched groups stay on the default after saving', () => {
  const store = storage();
  saveCanvasAppearance(store, { ...DEFAULT_CANVAS_APPEARANCE, pattern: 'none' });
  expect(readCanvasAppearance(store)).toEqual({ ...DEFAULT_CANVAS_APPEARANCE, pattern: 'none' });

  saveCanvasAppearance(store, {
    pattern: 'dots',
    background: '#E8ECF1',
    patternColor: '#39434F',
    patternOpacity: 0.24,
    backgroundCustomized: false,
    inkCustomized: false,
  });
  expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);
});

test('both retired factory looks migrate to the single default canvas', () => {
  const store = storage();
  for (const legacy of [
    { background: '#E8ECF1', patternColor: '#39434F', patternOpacity: 0.24 },
    { background: '#FBFBFA', patternColor: '#37352F', patternOpacity: 0.22 },
  ]) {
    store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({ pattern: 'dots', ...legacy }));
    expect(readCanvasAppearance(store)).toEqual(DEFAULT_CANVAS_APPEARANCE);
  }
});

test('a legacy record keeps whichever group the user did customize', () => {
  const store = storage();
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', background: '#112233', patternColor: '#39434F', patternOpacity: 0.24,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    background: '#112233',
    backgroundCustomized: true,
  });

  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', background: '#FBFBFA', patternColor: '#445566', patternOpacity: 0.5,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    patternColor: '#445566',
    patternOpacity: 0.5,
    inkCustomized: true,
  });

  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify({
    pattern: 'dots', background: '#FBFBFA', patternColor: '#39434F', patternOpacity: 0.5,
  }));
  expect(readCanvasAppearance(store)).toEqual({
    ...DEFAULT_CANVAS_APPEARANCE,
    patternColor: '#39434F',
    patternOpacity: 0.5,
    inkCustomized: true,
  });
});

test('explicit customization flags keep values that match a retired default', () => {
  const store = storage();
  const appearance: CanvasAppearance = {
    pattern: 'dots',
    background: '#E8ECF1',
    patternColor: '#37352F',
    patternOpacity: 0.22,
    backgroundCustomized: true,
    inkCustomized: true,
  };
  store.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify(appearance));
  expect(readCanvasAppearance(store)).toEqual(appearance);
});

test('pattern ink is rgba with a clamped alpha', () => {
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: '#ff0000', patternOpacity: 5 })).toBe('rgba(255, 0, 0, 1)');
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: '#0f0f0f', patternOpacity: 0.35 })).toBe('rgba(15, 15, 15, 0.35)');
  const fallbackHex = DEFAULT_CANVAS_APPEARANCE.patternColor.slice(1);
  const channel = (offset: number) => Number.parseInt(fallbackHex.slice(offset, offset + 2), 16);
  expect(patternInk({ ...DEFAULT_CANVAS_APPEARANCE, patternColor: 'nope', patternOpacity: 0.1 }))
    .toBe(`rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, 0.1)`);
});
