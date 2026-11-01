// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContentActions } from '../renderer/src/ui/ContentActions';
import type { AppState, ContentRecord } from '../shared/image-board';

afterEach(cleanup);

const content = (overrides: Partial<ContentRecord> & Pick<ContentRecord, 'id' | 'kind'>): ContentRecord => ({
  preview: '示例内容',
  textLength: 0,
  url: null,
  image: null,
  coverAsset: null,
  categoryId: null,
  source: 'clipboard',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const state = {
  activeCanvasId: 'root',
  canvases: [],
  categories: [{ id: 'work', name: '工作', createdAt: '2026-01-01T00:00:00.000Z' }],
  contents: {
    picture: content({ id: 'picture', kind: 'image', preview: 'shot.png', image: { fileName: 'shot.png', relativePath: 'images/shot.png', width: 640, height: 480, byteSize: 1024 } }),
    note: content({ id: 'note', kind: 'text', preview: '一段文字' }),
  },
  edges: [],
} as unknown as AppState;

function mount(overrides: Partial<React.ComponentProps<typeof ContentActions>> = {}) {
  const props: React.ComponentProps<typeof ContentActions> = {
    state,
    context: 'canvas',
    contentIds: ['picture'],
    nodeIds: ['node-1'],
    anchor: { left: 40, top: 40 },
    motion: 'idle',
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onError: vi.fn(),
    onNotice: vi.fn(),
    onOpen: vi.fn(),
    onCopy: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onRemoveNodes: vi.fn(),
    onGroupIntoCanvas: vi.fn(),
    ...overrides,
  };
  const view = render(<ContentActions {...props} />);
  return { props, view };
}

interface ActionsHostStub {
  classifyContents: ReturnType<typeof vi.fn>;
  createCategory: ReturnType<typeof vi.fn>;
}

/** The menu only reaches these two host calls; the rest of the API is out of scope here. */
const host: ActionsHostStub = { classifyContents: vi.fn(), createCategory: vi.fn() };

beforeEach(() => {
  host.classifyContents.mockReset();
  host.createCategory.mockReset();
  (window as unknown as { imageBoard: ActionsHostStub }).imageBoard = host;
});

test('canvas actions expose content and canvas-only items, and dispatch them', () => {
  const { props } = mount();
  for (const label of ['打开', '复制', '分类 ▾', '重命名', '创建子画布', '从画布移除', '删除内容…']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  fireEvent.click(screen.getByText('复制'));
  expect(props.onCopy).toHaveBeenCalledWith(['picture']);
  expect(props.onClose).toHaveBeenCalled();

  cleanup();
  const group = mount();
  fireEvent.click(screen.getByText('创建子画布'));
  expect(group.props.onGroupIntoCanvas).toHaveBeenCalledWith(['node-1']);

  cleanup();
  const remove = mount();
  fireEvent.click(screen.getByText('从画布移除'));
  expect(remove.props.onRemoveNodes).toHaveBeenCalledWith(['node-1']);

  cleanup();
  const removeContent = mount();
  fireEvent.click(screen.getByText('删除内容…'));
  expect(removeContent.props.onDelete).toHaveBeenCalledWith(['picture']);
});

test('library context hides canvas-only items and renames only single images', () => {
  mount({ context: 'library', nodeIds: [] });
  expect(screen.queryByText('创建子画布')).toBeNull();
  expect(screen.queryByText('从画布移除')).toBeNull();
  expect(screen.getByText('重命名')).toBeTruthy();

  cleanup();
  mount({ context: 'library', contentIds: ['note'], nodeIds: [] });
  expect(screen.queryByText('重命名')).toBeNull();
});

test('classification replaces the action list and calls classifyContents', async () => {
  const next = { ...state } as AppState;
  host.classifyContents.mockResolvedValue(next);
  const { props } = mount();
  fireEvent.click(screen.getByText('分类 ▾'));
  expect(screen.getByText('工作')).toBeTruthy();
  expect(screen.getByText('＋ 新分类')).toBeTruthy();
  expect(screen.queryByText('复制')).toBeNull();
  // Nothing classified yet: no clear action.
  expect(screen.queryByText('取消分类')).toBeNull();

  fireEvent.click(screen.getByText('工作'));
  await waitFor(() => expect(host.classifyContents).toHaveBeenCalledWith(['picture'], 'work'));
  expect(props.onUpdate).toHaveBeenCalledWith(next);
  expect(props.onNotice).toHaveBeenCalledWith('分类已保存');
  expect(props.onClose).toHaveBeenCalled();
});

test('an already classified content offers clearing its category', async () => {
  const classified = {
    ...state,
    contents: { picture: content({ id: 'picture', kind: 'image', categoryId: 'work' }) },
  } as unknown as AppState;
  host.classifyContents.mockResolvedValue(classified);
  const { props } = mount({ state: classified });
  fireEvent.click(screen.getByText('分类 ▾'));
  fireEvent.click(screen.getByText('取消分类'));
  await waitFor(() => expect(host.classifyContents).toHaveBeenCalledWith(['picture'], null));
  expect(props.onNotice).toHaveBeenCalledWith('已取消分类');
});

test('Escape closes the menu without touching the content', () => {
  const { props } = mount();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalled();
  expect(props.onDelete).not.toHaveBeenCalled();
});
