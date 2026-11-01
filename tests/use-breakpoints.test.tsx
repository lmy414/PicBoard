// @vitest-environment jsdom
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useWindowLayout } from '../renderer/src/ui/use-breakpoints';

type ObserverStub = { callback: ResizeObserverCallback };
let lastObserver: ObserverStub | null = null;

function setWindowWidth(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
}

let observers: ObserverStub[] = [];

beforeEach(() => {
  observers = [];
  lastObserver = null;
  setWindowWidth(1024);
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      const stub = this as unknown as ObserverStub;
      lastObserver = stub;
      observers.push(stub);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('window buckets update only when a boundary is crossed', () => {
  const { result } = renderHook(() => useWindowLayout());
  expect(result.current).toEqual({ sidebar: 'overlay', topbar: 'full' });
  act(() => {
    setWindowWidth(1280);
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ sidebar: 'docked', topbar: 'full' });
  // Same bucket: the hook keeps the previous state object (no re-render).
  const stable = result.current;
  act(() => {
    setWindowWidth(1300);
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toBe(stable);
  act(() => {
    setWindowWidth(700);
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ sidebar: 'overlay', topbar: 'compact' });
});


test('window buckets re-measure after a hidden window grows from a placeholder size', () => {
  // The host creates the main window hidden at 88x88 before applying the real size.
  setWindowWidth(88);
  const { result } = renderHook(() => useWindowLayout());
  expect(result.current).toEqual({ sidebar: 'overlay', topbar: 'compact' });

  // The host applies the real size while the window is still hidden: no resize
  // event is required — the document element observer re-measures.
  setWindowWidth(1400);
  const docObserver = observers.find((observer) => observer !== lastObserver) ?? observers[0];
  act(() => {
    docObserver.callback(
      [{ contentRect: { width: 1400, height: 900 } }] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
  });
  expect(result.current).toEqual({ sidebar: 'docked', topbar: 'full' });

  // And the resize listener keeps it current afterwards.
  act(() => {
    setWindowWidth(700);
    window.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ sidebar: 'overlay', topbar: 'compact' });
});
