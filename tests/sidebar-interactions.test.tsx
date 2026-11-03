// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../renderer/src/App';
import type { AppState, ImageBoardApi } from '../shared/image-board';

const time = '2026-01-01T00:00:00.000Z';
const state = { revision: 1, activeCanvasId: 'root', canvases: [
  { id: 'root', name: '主画布', parentId: null, frame: null, nodes: [], createdAt: time, viewport: { x: 0, y: 0, zoom: 1 } },
], categories: [], contents: {}, edges: [] } as unknown as AppState;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
  window.imageBoard = {
    loadState: vi.fn().mockResolvedValue(state), onStateChanged: vi.fn(() => () => {}),
    getDesktopSettings: vi.fn().mockResolvedValue({ captureEnabled: true, snapToGrid: false, gridSize: 24, historyRetentionDays: 30, closeBehavior: 'float', autoStart: false, autoStartAvailable: true }),
    isMaximized: vi.fn().mockResolvedValue(false), setCanvasViewport: vi.fn().mockResolvedValue(state),
    getPluginSettings: vi.fn().mockResolvedValue({ plugins: [] }), imageUrl: () => '',
  } as unknown as ImageBoardApi;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openApp() { render(<App />); await screen.findByRole('navigation', { name: '画布层级' }); }
const sidebar = () => document.querySelector<HTMLElement>('.sidebar')!;
const toggle = () => document.querySelector<HTMLButtonElement>('.sidebar-toggle')!;

test('floating actions pin the same panel and explicit collapse restores the topbar focus', async () => {
  await openApp();
  fireEvent.pointerOver(toggle());
  expect(document.querySelector('.sidebar-heading')).toBeNull();
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  expect(document.querySelector('.sidebar-search .sidebar-pin')).toBeTruthy();
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索画布' });
  fireEvent.change(input, { target: { value: '主' } });
  fireEvent.click(screen.getByRole('button', { name: '固定侧边栏', exact: true }));
  expect(sidebar().classList.contains('is-pinned')).toBe(true);
  expect(screen.getByRole('textbox', { name: '搜索画布' })).toBe(input);
  expect(input.value).toBe('主');
  fireEvent.click(toggle());
  expect(sidebar().classList.contains('closed')).toBe(true);
  expect(document.activeElement).toBe(toggle());
  expect(toggle().getAttribute('aria-controls')).toBe(sidebar().id);
  expect(document.querySelector('.sidebar-content')?.hasAttribute('inert')).toBe(true);
});

test('search Escape clears the query first, then closes the floating panel without leaking Escape', async () => {
  await openApp(); fireEvent.pointerOver(toggle());
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索画布' });
  input.focus(); fireEvent.change(input, { target: { value: '主' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input.value).toBe(''); expect(document.activeElement).toBe(input);
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(sidebar().classList.contains('closed')).toBe(true); expect(document.activeElement).toBe(toggle());
});

test('search focus holds a floating drawer across pointer departure', async () => {
  await openApp(); fireEvent.pointerOver(toggle());
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '搜索画布' });
  input.focus();
  vi.useFakeTimers();
  fireEvent.pointerOut(toggle()); fireEvent.pointerOver(sidebar()); fireEvent.pointerOut(sidebar());
  act(() => { vi.advanceTimersByTime(400); });
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  input.blur();
  act(() => { vi.advanceTimersByTime(240); });
  expect(sidebar().classList.contains('closed')).toBe(true);
});

test('tree menus keep the floating drawer open and Escape returns focus before dismissing the drawer', async () => {
  await openApp(); fireEvent.pointerOver(toggle()); fireEvent.pointerOut(toggle()); fireEvent.pointerOver(sidebar());
  const row = document.querySelector<HTMLElement>('.tree-node')!;
  fireEvent.contextMenu(row, { clientX: 180, clientY: 130 });
  await screen.findByRole('menu');
  vi.useFakeTimers();
  fireEvent.pointerOut(sidebar());
  act(() => { vi.advanceTimersByTime(400); });
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { vi.advanceTimersByTime(150); });
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: 'Escape' });
  expect(sidebar().classList.contains('closed')).toBe(true);
  expect(document.activeElement).toBe(toggle());
});

test('a canvas tree drag keeps the drawer mounted outside the panel until dragend', async () => {
  await openApp(); fireEvent.pointerOver(toggle()); fireEvent.pointerOut(toggle()); fireEvent.pointerOver(sidebar());
  const row = document.querySelector<HTMLElement>('.tree-node')!;
  vi.useFakeTimers();
  fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn(), effectAllowed: 'move' } });
  fireEvent.pointerOut(sidebar());
  act(() => { vi.advanceTimersByTime(400); });
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  fireEvent.dragEnd(row, { clientX: 600, clientY: 300 });
  act(() => { vi.advanceTimersByTime(240); });
  expect(sidebar().classList.contains('closed')).toBe(true);
});

test('settings owns a stable sidebar without changing the saved canvas pin choice', async () => {
  window.localStorage.setItem('quick-image-board.sidebar-collapsed', '1');
  await openApp(); fireEvent.pointerOver(toggle());
  fireEvent.click(screen.getByRole('button', { name: '打开设置', exact: true }));
  await screen.findByRole('textbox', { name: '搜索设置' });
  expect(sidebar().classList.contains('is-pinned')).toBe(true);
  expect(window.localStorage.getItem('quick-image-board.sidebar-collapsed')).toBe('1');
  fireEvent.change(screen.getByRole('textbox', { name: '搜索设置' }), { target: { value: '默认' } });
  expect(screen.getByRole('navigation', { name: '设置项目' }).querySelectorAll('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '返回画布', exact: true }));
  await screen.findByRole('navigation', { name: '画布层级' });
  expect(sidebar().classList.contains('closed')).toBe(true);
  expect(document.querySelector<HTMLInputElement>('.sidebar-search input')?.getAttribute('aria-label')).toBe('搜索画布');
});

test('the first closed sidebar mount becomes inert when the initial snapshot resolves', async () => {
  let resolveState!: (value: AppState) => void;
  vi.mocked(window.imageBoard.loadState).mockImplementation(() => new Promise(resolve => { resolveState = resolve; }));
  render(<App />);
  expect(document.querySelector('.sidebar-content')).toBeNull();
  await act(async () => { resolveState(state); });
  await screen.findByRole('navigation', { name: '画布层级' });
  expect(sidebar().classList.contains('closed')).toBe(true);
  expect(document.querySelector('.sidebar-content')?.hasAttribute('inert')).toBe(true);
});

test('CtrlK requested before the initial snapshot focuses search after its visible commit', async () => {
  let resolveState!: (value: AppState) => void;
  vi.mocked(window.imageBoard.loadState).mockImplementation(() => new Promise(resolve => { resolveState = resolve; }));
  render(<App />);
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  await act(async () => { resolveState(state); });
  const search = await screen.findByRole('textbox', { name: '搜索画布' });
  expect(sidebar().classList.contains('is-peeking')).toBe(true);
  expect(document.querySelector('.sidebar-content')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(search);
});
