// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../renderer/src/App';
import type { AppState } from '../shared/image-board';

const ISO = '2026-01-01T00:00:00.000Z';

const state = {
  revision: 1,
  activeCanvasId: 'root',
  canvases: [
    { id: 'root', name: '主画布', parentId: null, frame: null, nodes: [{ id: 'n1', contentId: 'c1', x: 100, y: 100, width: 280, height: 96 }], createdAt: ISO, viewport: { x: -900, y: -500, zoom: 1 } },
    { id: 'child', name: '子画布', parentId: 'root', frame: { x: 500, y: 200, width: 260, height: 160 }, nodes: [{ id: 'n2', contentId: 'c1', x: 10, y: 10, width: 280, height: 96 }], createdAt: ISO, viewport: { x: 0, y: 0, zoom: 1 } },
  ],
  categories: [],
  contents: {
    c1: { id: 'c1', kind: 'text', preview: '第一条笔记', textLength: 5, url: null, image: null, coverAsset: null, categoryId: null, source: 'clipboard', createdAt: ISO, updatedAt: ISO, lastUsedAt: ISO },
  },
  edges: [],
} as unknown as AppState;

interface AppHostStub {
  loadState: ReturnType<typeof vi.fn>;
  onStateChanged: ReturnType<typeof vi.fn>;
  getDesktopSettings: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  setActiveCanvas: ReturnType<typeof vi.fn>;
  setCanvasViewport: ReturnType<typeof vi.fn>;
  closeWindow: ReturnType<typeof vi.fn>;
  getContentBody: ReturnType<typeof vi.fn>;
  updateTextContent: ReturnType<typeof vi.fn>;
  openExternalUrl: ReturnType<typeof vi.fn>;
  imageUrl: (contentId: string, variant: string) => string;
}

/** Only the host surface the shell touches before any canvas gesture. */
let host: AppHostStub;

beforeEach(() => {
  host = {
    loadState: vi.fn().mockResolvedValue(state),
    onStateChanged: vi.fn(() => () => {}),
    getDesktopSettings: vi.fn().mockResolvedValue({ closeBehavior: 'float', autoStart: false, autoStartAvailable: false, captureEnabled: true, historyRetentionDays: 30, snapToGrid: false, gridSize: 24 }),
    isMaximized: vi.fn().mockResolvedValue(false),
    setActiveCanvas: vi.fn().mockResolvedValue({ ...state, activeCanvasId: 'child' }),
    setCanvasViewport: vi.fn().mockResolvedValue(state),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    getContentBody: vi.fn().mockResolvedValue({ text: '第一条笔记', html: null }),
    updateTextContent: vi.fn().mockResolvedValue(state),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    imageUrl: (contentId: string, variant: string) => `picboard://${variant}/${contentId}`,
  };
  (window as unknown as { imageBoard: AppHostStub }).imageBoard = host;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

test('the shell renders contents, sub-canvas cards and the open history drawer', async () => {
  render(<App />);
  expect((await screen.findAllByText('主画布')).length).toBeGreaterThan(0);
  expect((await screen.findAllByText('第一条笔记')).length).toBeGreaterThan(0);
  expect(screen.getAllByText('1 个节点').length).toBeGreaterThan(0);

  const node = document.querySelector<HTMLElement>('.canvas-node');
  expect(node).toBeTruthy();
  expect(node!.style.width).toBe('280px');
  expect(node!.style.height).toBe('96px');

  const card = document.querySelector<HTMLElement>('.canvas-node-card');
  expect(card).toBeTruthy();
  expect(card!.textContent).toContain('子画布');
  expect(card!.textContent).toContain('1 个节点 · 双击进入');

  const drawer = document.querySelector('.hist-drawer.is-open');
  expect(drawer).toBeTruthy();
  expect(document.querySelector('.history-slot.open')).toBeTruthy();

  const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
  expect(viewport.classList.contains('pattern-dots')).toBe(true);
  expect(viewport.style.getPropertyValue('--canvas-bg')).toBe('#FBFBFA');
  expect(viewport.style.backgroundSize).toBe('24px 24px');
  // Dots are centered in the tile: the world origin's screen offset maps to
  // (0, 16) for the default viewport (-900, -500) at grid 24.
  expect(viewport.style.backgroundPosition).toBe('0px 16px');
});

test('entering a sub-canvas switches the active canvas state', async () => {
  render(<App />);
  const card = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.canvas-node-card');
    expect(element).toBeTruthy();
    return element!;
  });
  fireEvent.doubleClick(card);
  await waitFor(() => expect(host.setActiveCanvas).toHaveBeenCalledWith('child'));
  expect((await screen.findAllByText('子画布')).length).toBeGreaterThan(0);
});

test('the history toggle collapses the drawer without unmounting the canvas', async () => {
  render(<App />);
  await screen.findAllByText('主画布');
  const toggle = screen.getAllByRole('button', { name: '收起剪贴板历史' })[0];
  fireEvent.click(toggle);
  await waitFor(() => expect(document.querySelector('.history-slot.open')).toBeNull());
  expect(document.querySelector('.canvas-node')).toBeTruthy();
  expect(host.setActiveCanvas).not.toHaveBeenCalled();
});

test('a full page overlays the canvas and returns through the origin crumb', async () => {
  render(<App />);
  const node = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.canvas-node');
    expect(element).toBeTruthy();
    return element!;
  });
  fireEvent.doubleClick(node);
  await waitFor(() => expect(document.querySelector('.page-layer')).toBeTruthy(), { timeout: 2000 });
  // The canvas stays mounted behind the page so its viewport/selection survive.
  expect(document.querySelector('.canvas-node')).toBeTruthy();

  fireEvent.click(await screen.findByRole('button', { name: '返回到主画布' }));
  await waitFor(() => expect(document.querySelector('.page-layer')).toBeNull(), { timeout: 2000 });
  expect(document.querySelector('.canvas-node')).toBeTruthy();
  expect(document.querySelector('.history-slot')).toBeTruthy();
});

function setInnerWidth(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
}

test('the topbar toggle drives the docked sidebar and Ctrl+Shift+S matches it', async () => {
  setInnerWidth(1400);
  render(<App />);
  await screen.findAllByText('主画布');

  const aside = document.querySelector<HTMLElement>('.sidebar')!;
  expect(aside.classList.contains('closed')).toBe(false);
  const toggle = screen.getByRole('button', { name: '隐藏侧边栏 (Ctrl+Shift+S)' });
  expect(toggle.getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(toggle);
  expect(document.querySelector('.sidebar.closed')).toBeTruthy();
  expect(screen.getByRole('button', { name: '显示侧边栏 (Ctrl+Shift+S)' }).getAttribute('aria-pressed')).toBe('false');

  fireEvent.keyDown(document, { key: 's', ctrlKey: true, shiftKey: true });
  expect(document.querySelector('.sidebar.closed')).toBeNull();
  expect(screen.getByRole('button', { name: '隐藏侧边栏 (Ctrl+Shift+S)' }).getAttribute('aria-pressed')).toBe('true');

  // Typing in an input never toggles: the shortcut guard skips editable targets.
  const input = document.querySelector<HTMLInputElement>('.sidebar-search input')!;
  fireEvent.keyDown(input, { key: 's', ctrlKey: true, shiftKey: true });
  expect(document.querySelector('.sidebar.closed')).toBeNull();
});

test('below the dock threshold the toggle slides the sheet over a backdrop and Esc closes it', async () => {
  setInnerWidth(1024);
  render(<App />);
  await screen.findAllByText('主画布');

  expect(document.querySelector('.sidebar.overlay-mode')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '显示侧边栏 (Ctrl+Shift+S)' }));
  expect(document.querySelector('.sidebar-sheet')).toBeTruthy();
  expect(document.querySelector('.sidebar-backdrop')).toBeTruthy();

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(document.querySelector('.sidebar-sheet')).toBeNull());
  expect(screen.getByRole('button', { name: '显示侧边栏 (Ctrl+Shift+S)' }).getAttribute('aria-pressed')).toBe('false');
});
