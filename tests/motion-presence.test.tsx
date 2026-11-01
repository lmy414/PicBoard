// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cubicBezierProgress, usePresence } from '../renderer/src/ui/motion';

let reduced = false;

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = ((query: string) => ({
    matches: reduced,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

afterEach(() => {
  vi.useRealTimers();
  reduced = false;
});

test('enter settles to idle and exit stays mounted for its window', () => {
  const { result, rerender } = renderHook(({ open }) => usePresence(open, 160), { initialProps: { open: true } });
  expect(result.current).toEqual({ mounted: true, phase: 'enter' });
  act(() => vi.advanceTimersByTime(200));
  expect(result.current).toEqual({ mounted: true, phase: 'idle' });

  rerender({ open: false });
  expect(result.current).toEqual({ mounted: true, phase: 'exit' });
  act(() => vi.advanceTimersByTime(159));
  expect(result.current.mounted).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current).toEqual({ mounted: false, phase: 'idle' });
});

test('reopening during the exit restarts the enter phase', () => {
  const { result, rerender } = renderHook(({ open }) => usePresence(open, 160), { initialProps: { open: true } });
  act(() => vi.advanceTimersByTime(200));
  rerender({ open: false });
  act(() => vi.advanceTimersByTime(80));
  expect(result.current.phase).toBe('exit');
  rerender({ open: true });
  expect(result.current).toEqual({ mounted: true, phase: 'enter' });
  act(() => vi.advanceTimersByTime(200));
  expect(result.current.phase).toBe('idle');
});

test('reduced motion settles and unmounts without waiting', () => {
  reduced = true;
  const { result, rerender } = renderHook(({ open }) => usePresence(open, 160), { initialProps: { open: true } });
  expect(result.current).toEqual({ mounted: true, phase: 'idle' });
  rerender({ open: false });
  expect(result.current).toEqual({ mounted: false, phase: 'idle' });
});

test('closed on mount stays unmounted', () => {
  const { result } = renderHook(() => usePresence(false));
  expect(result.current).toEqual({ mounted: false, phase: 'idle' });
});

test('cubic-bezier easing matches the CSS motion token endpoints', () => {
  const ease = (t: number) => cubicBezierProgress(0.16, 1, 0.3, 1, t);
  expect(ease(0)).toBe(0);
  expect(ease(1)).toBeCloseTo(1, 5);
  // The curve starts fast and lands softly: well past half-way at t = 0.3.
  expect(ease(0.3)).toBeGreaterThan(0.7);
  expect(ease(0.3)).toBeLessThan(1);
  expect(ease(0.5)).toBeGreaterThan(ease(0.3));
  expect(ease(-1)).toBe(0);
  expect(ease(2)).toBeCloseTo(1, 5);
});
