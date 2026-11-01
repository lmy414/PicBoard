// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  THEME_SWITCH_MS,
  applyTheme,
  isThemeId,
  readTheme,
  setTheme,
  startThemeSync,
  useTheme,
} from '../renderer/src/ui/theme';

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

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove('theme-switching');
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove('theme-switching');
});

describe('theme preference', () => {
  test('exposes clean and neumorphism with Chinese labels', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(['clean', 'neumorphism']);
    expect(THEMES.map((theme) => theme.label)).toEqual(['简洁', '新拟物']);
    expect(DEFAULT_THEME).toBe('clean');
  });

  test('missing, invalid and stored values resolve to a valid theme', () => {
    const store = storage();
    expect(readTheme(store)).toBe('clean');
    store.setItem(THEME_STORAGE_KEY, 'solarized');
    expect(readTheme(store)).toBe('clean');
    store.setItem(THEME_STORAGE_KEY, 'neumorphism');
    expect(readTheme(store)).toBe('neumorphism');
    expect(isThemeId('clean')).toBe(true);
    expect(isThemeId('')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  test('applyTheme mirrors the id onto the document root', () => {
    applyTheme('neumorphism', { animate: false });
    expect(document.documentElement.dataset.theme).toBe('neumorphism');
    applyTheme('clean', { animate: false });
    expect(document.documentElement.dataset.theme).toBe('clean');
  });

  test('setTheme persists the choice and crossfades with the switching class', () => {
    vi.useFakeTimers();
    applyTheme('clean', { animate: false });
    setTheme('neumorphism');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('neumorphism');
    expect(document.documentElement.dataset.theme).toBe('neumorphism');
    expect(document.documentElement.classList.contains('theme-switching')).toBe(true);
    vi.advanceTimersByTime(THEME_SWITCH_MS);
    expect(document.documentElement.classList.contains('theme-switching')).toBe(false);
  });

  test('storage events from the other window re-apply the theme', () => {
    applyTheme('clean', { animate: false });
    const stop = startThemeSync();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neumorphism');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'neumorphism' }));
    expect(document.documentElement.dataset.theme).toBe('neumorphism');
    expect(document.documentElement.classList.contains('theme-switching')).toBe(true);
    stop();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'clean');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'clean' }));
    expect(document.documentElement.dataset.theme).toBe('neumorphism');
  });

  test('useTheme re-renders subscribers when the preference changes', () => {
    act(() => setTheme('clean'));
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('clean');
    act(() => result.current.setTheme('neumorphism'));
    expect(result.current.theme).toBe('neumorphism');
    expect(document.documentElement.dataset.theme).toBe('neumorphism');
  });
});
