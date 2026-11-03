// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../renderer/src/App';
import type { AppState, ImageBoardApi, WindowResizeDirection } from '../shared/image-board';

const ISO = '2026-01-01T00:00:00.000Z';

const state = {
  revision: 1,
  activeCanvasId: 'root',
  canvases: [
    { id: 'root', name: '主画布', parentId: null, frame: null, nodes: [{ id: 'n1', contentId: 'c1', x: 100, y: 100, width: 280, height: 96 }], createdAt: ISO, viewport: { x: -900, y: -500, zoom: 1 } },
  ],
  categories: [],
  contents: {
    c1: { id: 'c1', kind: 'text', preview: '第一条笔记', textLength: 5, url: null, image: null, coverAsset: null, categoryId: null, source: 'clipboard', createdAt: ISO, updatedAt: ISO, lastUsedAt: ISO },
  },
  edges: [],
} as unknown as AppState;

type ROEntry = { contentRect: { width: number; height: number } };
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(entry: ROEntry) {
    this.callback([entry] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
  }
}

/** One-step window geometry change: resize event + every live observer. */
function resizeWindow(width: number, height: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    window.dispatchEvent(new Event('resize'));
    for (const observer of ResizeObserverStub.instances) observer.fire({ contentRect: { width, height } });
  });
}

const host = {
  loadState: vi.fn().mockResolvedValue(state),
  onStateChanged: vi.fn(() => () => {}),
  getDesktopSettings: vi.fn().mockResolvedValue({ closeBehavior: 'float', autoStart: false, autoStartAvailable: false, captureEnabled: true, historyRetentionDays: 30, snapToGrid: false, gridSize: 24 }),
  isMaximized: vi.fn().mockResolvedValue(false),
  setActiveCanvas: vi.fn().mockResolvedValue(state),
  setCanvasViewport: vi.fn().mockResolvedValue(state),
  createCanvas: vi.fn().mockResolvedValue(state),
  toggleMaximized: vi.fn().mockResolvedValue(true),
  startTitlebarDrag: vi.fn().mockResolvedValue(undefined),
  startResizeDragging: vi.fn().mockResolvedValue(undefined),
  closeWindow: vi.fn().mockResolvedValue(undefined),
  getContentBody: vi.fn().mockResolvedValue({ text: '第一条笔记', html: null }),
  updateTextContent: vi.fn().mockResolvedValue(state),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
  imageUrl: (contentId: string, variant: string) => `picboard://${variant}/${contentId}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  host.isMaximized.mockResolvedValue(false);
  host.toggleMaximized.mockResolvedValue(true);
  host.setCanvasViewport.mockResolvedValue(state);
  host.startTitlebarDrag.mockResolvedValue(undefined);
  host.startResizeDragging.mockResolvedValue(undefined);
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  });
  const captured = new WeakMap<HTMLElement, number>();
  HTMLElement.prototype.setPointerCapture = function (id: number) { captured.set(this, id); };
  HTMLElement.prototype.releasePointerCapture = function (id: number) { if (captured.get(this) === id) captured.delete(this); };
  HTMLElement.prototype.hasPointerCapture = function (id: number) { return captured.get(this) === id; };
  ResizeObserverStub.instances = [];
  window.localStorage.clear();
  // The stub covers the host surface these shell tests exercise.
  const hostBoundary = host as unknown as ImageBoardApi;
  window.imageBoard = hostBoundary;
  const globalScope = globalThis as unknown as { ResizeObserver: unknown };
  globalScope.ResizeObserver = ResizeObserverStub;
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  Element.prototype.scrollIntoView = () => {};
  resizeWindow(1000, 700);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function finiteText(value: string): boolean {
  const numbers = value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  return numbers.every((token) => Number.isFinite(Number(token)));
}

test('maximizing in one step and restoring keeps buckets, transform and background finite', async () => {
  render(<App />);
  await screen.findAllByText('主画布');

  resizeWindow(2560, 1400);
  expect(document.querySelector('.sidebar.is-pinned')).toBeTruthy();
  expect(document.querySelector('.sidebar.closed')).toBeNull();

  const world = document.querySelector<HTMLElement>('.canvas-world')!;
  expect(world).toBeTruthy();
  expect(finiteText(world.style.transform)).toBe(true);
  const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
  expect(finiteText(viewport.style.backgroundPosition)).toBe(true);
  expect(finiteText(viewport.style.backgroundSize)).toBe(true);

  resizeWindow(1000, 700);
  expect(document.querySelector('.sidebar.closed')).toBeTruthy();
  expect(document.querySelector('.sidebar.is-pinned')).toBeNull();
  expect(finiteText(document.querySelector<HTMLElement>('.canvas-world')!.style.transform)).toBe(true);
});

test('the shell marks the maximized window so root clipping can follow', async () => {
  resizeWindow(1200, 800);
  render(<App />);
  await screen.findAllByText('主画布');
  const shell = document.querySelector<HTMLElement>('.app-shell')!;
  expect(shell.classList.contains('is-maximized')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '最大化窗口' }));
  await waitFor(() => expect(shell.classList.contains('is-maximized')).toBe(true));
});

test('the open drawer no longer feeds its own slot width back into the layout bucket', async () => {
  // 1200 - 248 sidebar = 952 main; with the 300 px slot open the old
  // element-measured bucket saw 652 < 780 and flipped to overlay every frame.
  resizeWindow(1200, 800);
  render(<App />);
  await screen.findAllByText('主画布');

  const slot = document.querySelector<HTMLElement>('.history-slot')!;
  expect(slot.classList.contains('overlay')).toBe(false);

  // Deliver the post-open main width the old code measured: the bucket must not flip.
  act(() => {
    for (const observer of ResizeObserverStub.instances) observer.fire({ contentRect: { width: 652, height: 800 } });
  });
  expect(document.querySelector<HTMLElement>('.history-slot')!.classList.contains('overlay')).toBe(false);

  // With the default pin at 1200 px the main area is 952 px; the drawer docks
  // while the canvas keeps 480 px beside it: innerWidth - 248 - 300 >= 480.
  resizeWindow(1028, 800);
  expect(document.querySelector<HTMLElement>('.history-slot')!.classList.contains('overlay')).toBe(false);
  // Below the 1100 px default the sidebar is collapsed (0 px), so the drawer
  // still sees the full width; at 750 it can no longer fit and goes overlay.
  resizeWindow(750, 800);
  expect(document.querySelector<HTMLElement>('.history-slot')!.classList.contains('overlay')).toBe(true);
});


function pointer(target: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', x: number, y: number, button = 0) {
  fireEvent[type](target, { pointerId: 1, button, buttons: type === 'pointerUp' ? 0 : 1, clientX: x, clientY: y });
}

test('a titlebar drag waits for its threshold and hands the gesture to the host once', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const titlebar = document.querySelector('.window-drag-region')!;
  pointer(titlebar, 'pointerDown', 300, 20);
  pointer(titlebar, 'pointerMove', 303, 22);
  expect(host.startTitlebarDrag).not.toHaveBeenCalled();
  pointer(titlebar, 'pointerMove', 309, 22);
  pointer(titlebar, 'pointerMove', 320, 22);
  await waitFor(() => expect(host.startTitlebarDrag).toHaveBeenCalledTimes(1));
});

test('right click, titlebar buttons and cancelled pointers never start a window drag', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const titlebar = document.querySelector('.window-drag-region')!;
  pointer(titlebar, 'pointerDown', 300, 20, 2);
  pointer(titlebar, 'pointerMove', 320, 20);
  const canvasButton = titlebar.querySelector('button')!;
  pointer(canvasButton, 'pointerDown', 300, 20);
  pointer(titlebar, 'pointerMove', 320, 20);
  pointer(titlebar, 'pointerDown', 300, 20);
  pointer(titlebar, 'pointerCancel', 300, 20);
  pointer(titlebar, 'pointerMove', 320, 20);
  pointer(titlebar, 'pointerDown', 300, 20);
  fireEvent.lostPointerCapture(titlebar, { pointerId: 1 });
  pointer(titlebar, 'pointerMove', 320, 20);
  expect(host.startTitlebarDrag).not.toHaveBeenCalled();
});

test('double clicking titlebar blank space toggles maximize but canvas trail controls do not', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const titlebar = document.querySelector('.window-drag-region')!;
  fireEvent.doubleClick(titlebar.querySelector('button')!);
  expect(host.toggleMaximized).not.toHaveBeenCalled();
  fireEvent.doubleClick(titlebar);
  await waitFor(() => expect(host.toggleMaximized).toHaveBeenCalledTimes(1));
  expect(document.querySelector('.window-resize-handles')).toBeNull();
});

test('all eight edge zones invoke native sizing without starting titlebar or canvas gestures', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const viewportCallsBefore = host.setCanvasViewport.mock.calls.length;
  const directions: WindowResizeDirection[] = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'];
  for (const direction of directions) {
    const edge = document.querySelector(`[data-resize-direction="${direction}"]`)!;
    expect(edge).toBeTruthy();
    pointer(edge, 'pointerDown', 0, 0, 2);
    expect(host.startResizeDragging).not.toHaveBeenCalledWith(direction);
    pointer(edge, 'pointerDown', 0, 0);
    expect(host.startResizeDragging).toHaveBeenLastCalledWith(direction);
  }
  expect(host.startTitlebarDrag).not.toHaveBeenCalled();
  expect(host.setCanvasViewport).toHaveBeenCalledTimes(viewportCallsBefore);
});

test('drag completion reads the actual OS state instead of forcing an unmaximized shell', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  await waitFor(() => expect(host.isMaximized).toHaveBeenCalled());
  host.isMaximized.mockResolvedValue(true);
  const titlebar = document.querySelector('.window-drag-region')!;
  pointer(titlebar, 'pointerDown', 300, 20);
  pointer(titlebar, 'pointerMove', 312, 20);
  await waitFor(() => expect(document.querySelector('.app-shell.is-maximized')).toBeTruthy());
  expect(document.querySelector('.window-resize-handles')).toBeNull();
});

test('system maximize and restore events synchronize the shell and edge zones', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  host.isMaximized.mockResolvedValue(true);
  resizeWindow(1920, 1040);
  await waitFor(() => expect(document.querySelector('.app-shell.is-maximized')).toBeTruthy());
  expect(document.querySelector('.window-resize-handles')).toBeNull();
  host.isMaximized.mockResolvedValue(false);
  resizeWindow(1000, 700);
  await waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(8));
});


test('native titlebar handoff never takes DOM capture and continues outside the header', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const titlebar = document.querySelector<HTMLElement>('.window-drag-region')!;
  const capture = vi.spyOn(titlebar, 'setPointerCapture');
  pointer(titlebar, 'pointerDown', 300, 20);
  expect(capture).not.toHaveBeenCalled();
  pointer(document.body, 'pointerMove', 340, 100);
  await waitFor(() => expect(host.startTitlebarDrag).toHaveBeenCalledTimes(1));
});

test('releasing outside the header cancels a pending titlebar gesture', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const titlebar = document.querySelector('.window-drag-region')!;
  pointer(titlebar, 'pointerDown', 300, 20);
  pointer(document.body, 'pointerUp', 301, 20);
  pointer(document.body, 'pointerMove', 340, 100);
  expect(host.startTitlebarDrag).not.toHaveBeenCalled();
});
