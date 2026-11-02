// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../renderer/src/App';
import type { AppState, ImageBoardApi } from '../shared/image-board';

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
  closeWindow: vi.fn().mockResolvedValue(undefined),
  getContentBody: vi.fn().mockResolvedValue({ text: '第一条笔记', html: null }),
  updateTextContent: vi.fn().mockResolvedValue(state),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
  imageUrl: (contentId: string, variant: string) => `picboard://${variant}/${contentId}`,
};

beforeEach(() => {
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

afterEach(cleanup);

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
