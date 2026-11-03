// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../renderer/src/App';
import type { AppState, ImageBoardApi } from '../shared/image-board';

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

const childState: AppState = { ...state, activeCanvasId: 'child' };

interface AppHostStub {
  loadState: Mock;
  onStateChanged: Mock;
  getDesktopSettings: Mock;
  isMaximized: Mock;
  setActiveCanvas: Mock;
  setCanvasViewport: Mock;
  createCanvas: Mock;
  toggleMaximized: Mock;
  startTitlebarDrag: Mock;
  closeWindow: Mock;
  copyContents: Mock;
  getContentBody: Mock;
  updateTextContent: Mock;
  openExternalUrl: Mock;
  imageUrl: (contentId: string, variant: string) => string;
}

/** Only the host surface the shell touches before any canvas gesture. */
let host: AppHostStub;

beforeEach(() => {
  window.localStorage.clear();
  setInnerWidth(1024);
  host = {
    loadState: vi.fn().mockResolvedValue(state),
    onStateChanged: vi.fn(() => () => {}),
    getDesktopSettings: vi.fn().mockResolvedValue({ closeBehavior: 'float', autoStart: false, autoStartAvailable: false, captureEnabled: true, historyRetentionDays: 30, snapToGrid: false, gridSize: 24 }),
    isMaximized: vi.fn().mockResolvedValue(false),
    setActiveCanvas: vi.fn().mockResolvedValue({ ...state, activeCanvasId: 'child' }),
    setCanvasViewport: vi.fn().mockResolvedValue(state),
    createCanvas: vi.fn().mockResolvedValue(state),
    toggleMaximized: vi.fn().mockResolvedValue(false),
    startTitlebarDrag: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    copyContents: vi.fn().mockResolvedValue({ copied: 1 }),
    getContentBody: vi.fn().mockResolvedValue({ text: '第一条笔记', html: null }),
    updateTextContent: vi.fn().mockResolvedValue(state),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    imageUrl: (contentId: string, variant: string) => `picboard://${variant}/${contentId}`,
  };
  // The stub covers only the host surface exercised before any canvas gesture.
  const hostBoundary = host as unknown as ImageBoardApi;
  window.imageBoard = hostBoundary;
  const globalScope = globalThis as unknown as { ResizeObserver: unknown };
  globalScope.ResizeObserver = class {
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('the shell renders contents, sub-canvas cards and the open history drawer', async () => {
  render(<App />);
  expect((await screen.findAllByText('主画布')).length).toBeGreaterThan(0);
  expect((await screen.findAllByText('第一条笔记')).length).toBeGreaterThan(0);
  expect(screen.getByRole('navigation', { name: '画布层级' }).textContent).toContain('主画布');

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

  const toolbar = await screen.findByRole('toolbar', { name: '内容工具' });
  expect(toolbar.closest('.workspace-toolbar-host')).toBeTruthy();
  expect(document.querySelector('.page-layer .cp-toolbar, .page-layer .cp-header')).toBeNull();
  expect(screen.queryByRole('dialog', { name: '内容信息' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '内容信息' }));
  expect(screen.getByRole('dialog', { name: '内容信息' }).textContent).toContain('出现在 2 个画布');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '内容信息' })).toBeNull();
  expect(document.querySelector('.page-layer')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  await waitFor(() => expect(host.copyContents).toHaveBeenCalledWith(['c1']));

  fireEvent.click(await screen.findByRole('button', { name: '返回到主画布' }));
  await waitFor(() => expect(document.querySelector('.page-layer')).toBeNull(), { timeout: 2000 });
  expect(document.querySelector('.canvas-node')).toBeTruthy();
  expect(document.querySelector('.history-slot')).toBeTruthy();
});

test('settings has one entry in the sidebar footer and opens from there', async () => {
  setInnerWidth(1400);
  render(<App />);
  const settings = await screen.findByRole('button', { name: '打开设置' });
  expect(settings.closest('.sidebar-footer')).toBeTruthy();
  expect(document.querySelector('.topbar .settings-button')).toBeNull();
  fireEvent.click(settings);
  expect(await screen.findByRole('heading', { name: '画布', level: 1 })).toBeTruthy();
  expect(screen.getByRole('navigation', { name: '设置项目' })).toBeTruthy();
  expect(settings.getAttribute('aria-pressed')).toBe('true');
});

test('library tools stay at the top and preserve filters when returning from content', async () => {
  setInnerWidth(1400);
  render(<App />);
  await screen.findAllByText('主画布');
  fireEvent.click(screen.getAllByRole('button', { name: '分类库', exact: true })[0]);
  const toolbar = await screen.findByRole('toolbar', { name: '分类库工具' });
  expect(toolbar.closest('.workspace-toolbar-host')).toBeTruthy();
  expect(document.querySelector('.lib-view .lib-toolbar')).toBeNull();
  const search = screen.getByRole('textbox', { name: '搜索内容' });
  fireEvent.change(search, { target: { value: '第一条' } });
  fireEvent.change(screen.getByRole('combobox', { name: '按分类筛选' }), { target: { value: 'none' } });
  const card = document.querySelector<HTMLElement>('.lib-grid > .lib-card')!;
  expect(card).toBeTruthy();
  fireEvent.click(card);
  expect(screen.getByRole('button', { name: '操作选中内容' }).closest('.workspace-toolbar-host')).toBeTruthy();
  expect(document.querySelector('.selection-toolbar')).toBeNull();
  fireEvent.doubleClick(card);
  await screen.findByRole('toolbar', { name: '内容工具' });
  expect(screen.queryByRole('toolbar', { name: '分类库工具' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回到分类库' }));
  await screen.findByRole('toolbar', { name: '分类库工具' });
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: '搜索内容' }).value).toBe('第一条');
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '按分类筛选' }).value).toBe('none');
  expect(screen.queryByRole('toolbar', { name: '内容工具' })).toBeNull();
});

test('Escape dismisses a hovered sidebar peek before the open page', async () => {
  setInnerWidth(900);
  render(<App />);
  const node = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.canvas-node');
    expect(element).toBeTruthy();
    return element!;
  });
  fireEvent.doubleClick(node);
  await waitFor(() => expect(document.querySelector('.page-layer')).toBeTruthy(), { timeout: 2000 });

  const aside = document.querySelector<HTMLElement>('.sidebar')!;
  const toggle = document.querySelector<HTMLElement>('.sidebar-toggle')!;
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(true);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(aside.classList.contains('closed')).toBe(true);
  // The page must stay open behind the dismissed peek.
  expect(document.querySelector('.page-layer')).toBeTruthy();

  // The next Escape still belongs to the page.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(document.querySelector('.page-layer')).toBeNull(), { timeout: 2000 });
});

function setInnerWidth(value: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
}

test('the topbar toggle pins and unpins on a wide window and the shortcut matches it', async () => {
  setInnerWidth(1400);
  render(<App />);
  await screen.findAllByText('主画布');

  const aside = document.querySelector<HTMLElement>('.sidebar')!;
  const toggle = document.querySelector<HTMLElement>('.sidebar-toggle')!;
  expect(aside.classList.contains('is-pinned')).toBe(true);
  expect(aside.classList.contains('closed')).toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');

  // Hovering a pinned sidebar is inert: it already occupies its width.
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(false);

  // Clicking an open sidebar collapses it even while the trigger is hovered.
  fireEvent.click(toggle);
  expect(aside.classList.contains('is-pinned')).toBe(false);
  expect(aside.classList.contains('closed')).toBe(true);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  fireEvent.keyDown(document, { key: 's', ctrlKey: true, shiftKey: true });
  expect(aside.classList.contains('is-pinned')).toBe(true);
  expect(aside.classList.contains('closed')).toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');

  // Typing in a field never toggles: the shortcut guard skips editable targets.
  const input = document.querySelector<HTMLInputElement>('.sidebar-search input')!;
  fireEvent.keyDown(input, { key: 's', ctrlKey: true, shiftKey: true });
  expect(aside.classList.contains('is-pinned')).toBe(true);
});

test('hovering the closed sidebar peeks without pinning; crossing to the panel keeps it and leaving, Esc or an outside press dismisses it', async () => {
  setInnerWidth(900);
  render(<App />);
  await screen.findAllByText('主画布');

  const aside = document.querySelector<HTMLElement>('.sidebar')!;
  const toggle = document.querySelector<HTMLElement>('.sidebar-toggle')!;
  expect(aside.classList.contains('closed')).toBe(true);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  vi.useFakeTimers();
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(true);
  expect(aside.classList.contains('is-pinned')).toBe(false);
  expect(document.querySelector('.sidebar-backdrop, .sidebar-sheet')).toBeNull();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  // A peek floats over the workspace: the history drawer keeps the full width.
  expect(document.querySelector<HTMLElement>('.history-slot')!.classList.contains('overlay')).toBe(false);

  // Cross the trigger→panel gap inside the grace: entering the panel cancels close.
  fireEvent.pointerOut(toggle, { relatedTarget: aside });
  fireEvent.pointerOver(aside, { relatedTarget: toggle });
  act(() => { vi.advanceTimersByTime(300); });
  expect(aside.classList.contains('is-peeking')).toBe(true);
  expect(aside.classList.contains('is-pinned')).toBe(false);

  // Leaving the panel waits the grace, then collapses without pinning.
  fireEvent.pointerOut(aside, { relatedTarget: document.body });
  act(() => { vi.advanceTimersByTime(120); });
  expect(aside.classList.contains('is-peeking')).toBe(true);
  act(() => { vi.advanceTimersByTime(120); });
  expect(aside.classList.contains('closed')).toBe(true);
  expect(aside.classList.contains('is-pinned')).toBe(false);

  // Esc dismisses a fresh peek.
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(aside.classList.contains('closed')).toBe(true);
  expect(aside.classList.contains('is-pinned')).toBe(false);

  // A press on the workspace also dismisses the floating panel.
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(true);
  fireEvent.pointerDown(document.querySelector<HTMLElement>('.workspace-main')!);
  expect(aside.classList.contains('closed')).toBe(true);
});

test('clicking pins on a narrow window, keeps that choice across resizes, and closes immediately under the pointer', async () => {
  setInnerWidth(900);
  render(<App />);
  await screen.findAllByText('主画布');

  const aside = document.querySelector<HTMLElement>('.sidebar')!;
  const toggle = document.querySelector<HTMLElement>('.sidebar-toggle')!;
  vi.useFakeTimers();

  fireEvent.pointerOver(toggle);
  const search = document.querySelector<HTMLInputElement>('.sidebar-search input')!;
  fireEvent.change(search, { target: { value: '主' } });
  fireEvent.click(toggle);
  expect(aside.classList.contains('is-pinned')).toBe(true);
  expect(aside.classList.contains('is-peeking')).toBe(false);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  // Peek and pin share one panel: the same search node keeps its text.
  expect(document.querySelector<HTMLInputElement>('.sidebar-search input')).toBe(search);
  expect(search.value).toBe('主');
  // A real pin claims 248 px, so the drawer can no longer dock at 900 px.
  expect(document.querySelector<HTMLElement>('.history-slot')!.classList.contains('overlay')).toBe(true);

  // Leaving after pinning no longer collapses it.
  fireEvent.pointerOut(toggle);
  act(() => { vi.advanceTimersByTime(300); });
  expect(aside.classList.contains('is-pinned')).toBe(true);

  // The explicit pin survives crossing the breakpoint both ways.
  act(() => { setInnerWidth(1400); window.dispatchEvent(new Event('resize')); });
  expect(aside.classList.contains('is-pinned')).toBe(true);
  act(() => { setInnerWidth(800); window.dispatchEvent(new Event('resize')); });
  expect(aside.classList.contains('is-pinned')).toBe(true);

  // Closing must not leave a hover peek behind, even with the pointer stationary.
  fireEvent.pointerOver(toggle);
  fireEvent.click(toggle);
  expect(aside.classList.contains('is-pinned')).toBe(false);
  expect(aside.classList.contains('is-peeking')).toBe(false);
  expect(aside.classList.contains('closed')).toBe(true);
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(window.localStorage.getItem('quick-image-board.sidebar-collapsed')).toBe('1');
  act(() => { vi.advanceTimersByTime(250); });
  expect(aside.classList.contains('closed')).toBe(true);

  // Now explicitly unpinned; widening must not silently re-pin.
  act(() => { setInnerWidth(1400); window.dispatchEvent(new Event('resize')); });
  expect(aside.classList.contains('is-pinned')).toBe(false);
  expect(aside.classList.contains('closed')).toBe(true);

  // A fresh hover still previews the sidebar after an explicit close.
  fireEvent.pointerOut(toggle);
  fireEvent.pointerOver(toggle);
  expect(aside.classList.contains('is-peeking')).toBe(true);
  expect(aside.classList.contains('is-pinned')).toBe(false);
});

test('the trail keeps the add entry without an active canvas and creates a root canvas', async () => {
  const emptyState: AppState = { ...state, activeCanvasId: '', canvases: [] };
  host.loadState.mockResolvedValue(emptyState);
  setInnerWidth(1400);
  render(<App />);

  await screen.findAllByText('画布不存在');
  expect(document.querySelectorAll('.canvas-trail-item')).toHaveLength(0);
  const add = await screen.findByRole('button', { name: '新建画布' });
  fireEvent.click(add);
  await waitFor(() => expect(host.createCanvas).toHaveBeenCalledWith());
});

test('the topbar trail shows the ancestor chain, adds a child of the active canvas and switches through ancestors', async () => {
  host.loadState.mockResolvedValue(childState);
  host.createCanvas.mockResolvedValue(childState);
  host.setActiveCanvas.mockImplementation((canvasId: string) => Promise.resolve({ ...state, activeCanvasId: canvasId }));
  setInnerWidth(1400);
  render(<App />);

  const trail = await screen.findByRole('navigation', { name: '画布层级' });
  const items = trail.querySelectorAll<HTMLElement>('.canvas-trail-item');
  expect(Array.from(items, (item) => item.textContent)).toEqual(['主画布', '子画布']);
  // The topbar trail replaces the old in-canvas breadcrumb row.
  expect(document.querySelector('.canvas-breadcrumb')).toBeNull();
  expect(items[0].getAttribute('aria-current')).toBeNull();
  expect(items[1].getAttribute('aria-current')).toBe('page');
  expect(items[1].classList.contains('is-current')).toBe(true);

  // "+" creates a child of the active canvas, not a root canvas.
  const add = screen.getByRole('button', { name: '新建子画布' });
  fireEvent.click(add);
  await waitFor(() => expect(host.createCanvas).toHaveBeenCalledWith('child'));

  // Titlebar navigation never starts a window drag or a double-click maximize.
  fireEvent.pointerDown(items[1], { button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(items[1], { buttons: 1, pointerId: 1, clientX: 60, clientY: 20 });
  expect(host.startTitlebarDrag).not.toHaveBeenCalled();
  fireEvent.doubleClick(items[1]);
  expect(host.toggleMaximized).not.toHaveBeenCalled();

  const ancestors = trail.querySelectorAll<HTMLElement>('.canvas-trail-item');
  fireEvent.click(ancestors[0]);
  await waitFor(() => expect(host.setActiveCanvas).toHaveBeenCalledWith('root'));
});
