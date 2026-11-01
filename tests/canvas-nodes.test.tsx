// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CanvasNodeView } from '../renderer/src/canvas/CanvasNodeView';
import { EdgeLayer } from '../renderer/src/canvas/EdgeLayer';
import type { CanvasNode, ContentRecord } from '../shared/image-board';
import type { ResolvedEdge } from '../shared/edge-geometry';

afterEach(cleanup);

const node: CanvasNode = { id: 'n1', contentId: 'c1', x: 40, y: 60, width: 280, height: 88 };

const baseContent: Omit<ContentRecord, 'kind' | 'preview'> = {
  id: 'c1',
  textLength: 0,
  url: null,
  image: null,
  coverAsset: null,
  categoryId: null,
  source: 'clipboard',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-01T00:00:00.000Z',
};

function view(content: ContentRecord, overrides: Partial<React.ComponentProps<typeof CanvasNodeView>> = {}) {
  const props: React.ComponentProps<typeof CanvasNodeView> = {
    node,
    content,
    selected: false,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onPointerCancel: vi.fn(),
    onConnectStart: vi.fn(),
    onOpen: vi.fn(),
    onToggleSelect: vi.fn(),
    onQuickActions: vi.fn(),
    onElement: vi.fn(),
    ...overrides,
  };
  const result = render(<CanvasNodeView {...props} />);
  return { props, container: result.container };
}

beforeEach(() => {
  (window as unknown as {
    imageBoard: {
      imageUrl: (id: string, variant: string) => string;
      assetUrl: (contentId: string, assetId: string, variant: string) => string;
    };
  }).imageBoard = {
    imageUrl: (id: string, variant: string) => `picboard://${variant}/${id}`,
    assetUrl: (contentId: string, assetId: string, variant: string) => `picboard://asset-${variant}/${contentId}/${assetId}`,
  };
});

test('image nodes render the host thumb at the exact node size with a fallback', () => {
  const { container } = view({ ...baseContent, kind: 'image', preview: 'shot.png', image: { fileName: 'shot.png', relativePath: 'x/shot.png', width: 640, height: 480, byteSize: 2048 } });
  const article = container.querySelector<HTMLElement>('.canvas-node')!;
  expect(article.style.width).toBe('280px');
  expect(article.style.height).toBe('88px');
  expect(article.style.left).toBe('40px');
  expect(article.className).toContain('node-image');
  const image = container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('picboard://thumb/c1');
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(image.getAttribute('decoding')).toBe('async');
  expect(image.draggable).toBe(false);
  expect(container.textContent).toContain('shot.png');

  fireEvent.error(image);
  expect(container.textContent).toContain('预览不可用');
});

test('text and link bodies show the documented card content', () => {
  const text = view({ ...baseContent, kind: 'text', preview: '第一行\n第二行', textLength: 7 });
  expect(text.container.textContent).toContain('文本');
  expect(text.container.textContent).toContain('第一行');
  expect(text.container.querySelector('.node-text-body')!.textContent).toBe('第一行\n第二行');

  cleanup();
  const link = view({ ...baseContent, kind: 'link', preview: 'https://example.com/a/b', url: 'https://example.com/a/b' });
  expect(link.container.textContent).toContain('链接');
  expect(link.container.textContent).toContain('example.com');
  expect(link.container.textContent).toContain('https://example.com/a/b');
});

test('single and double click and keyboard intents map to the documented callbacks', () => {
  const { props, container } = view({ ...baseContent, kind: 'text', preview: '内容' });
  const article = container.querySelector<HTMLElement>('.canvas-node')!;
  expect(article.getAttribute('role')).toBe('button');
  expect(article.getAttribute('tabIndex')).toBe('0');

  fireEvent.doubleClick(article);
  expect(props.onOpen).toHaveBeenCalledWith(node, article);

  fireEvent.keyDown(article, { key: 'Enter' });
  expect(props.onOpen).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(article, { key: 'Enter', shiftKey: true });
  expect(props.onToggleSelect).toHaveBeenCalledWith('n1');

  fireEvent.contextMenu(article);
  expect(props.onQuickActions).toHaveBeenCalled();

  expect(container.querySelectorAll('.node-handle')).toHaveLength(4);
  fireEvent.pointerDown(container.querySelector('.handle-right')!, { button: 0, pointerId: 1 });
  expect(props.onConnectStart).toHaveBeenCalledWith(expect.anything(), node, 'right');
});

const edge = (id: string, fromNode: string, toNode: string, fromRect: { x: number; y: number; width: number; height: number }, toRect: { x: number; y: number; width: number; height: number }): ResolvedEdge => ({
  edgeId: id,
  from: { kind: 'node', nodeId: fromNode, rect: fromRect },
  to: { kind: 'node', nodeId: toNode, rect: toRect },
});

test('edges point at the target side and expose selection and menu intents', () => {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const edges = [edge('e1', 'a', 'b', { x: 0, y: 0, width: 100, height: 60 }, { x: 300, y: 10, width: 100, height: 60 })];
  const { container } = render(<EdgeLayer edges={edges} selectedIds={['e1']} onSelect={onSelect} onContextMenu={onContextMenu} />);
  const group = container.querySelector('.edge')!;
  expect(group.classList.contains('selected')).toBe(true);
  const arrow = container.querySelector('.edge-arrow')!;
  expect(arrow.getAttribute('transform')).toBe('translate(300 40) rotate(0)');
  const line = container.querySelector('.edge-line')!;
  expect(line.getAttribute('pathLength')).toBe('1');

  const hit = container.querySelector('.edge-hit')!;
  fireEvent.click(hit, { shiftKey: true });
  expect(onSelect).toHaveBeenCalledWith('e1', true);
  fireEvent.contextMenu(hit, { clientX: 12, clientY: 34 });
  expect(onContextMenu).toHaveBeenCalledWith('e1', 12, 34);
});

test('rich-text nodes with a cover show the 128px asset strip above the padded body', () => {
  const { container } = view({ ...baseContent, kind: 'richText', preview: '带图正文', coverAsset: 'c1/a1' });
  const article = container.querySelector<HTMLElement>('.canvas-node')!;
  expect(article.classList.contains('node-with-cover')).toBe(true);
  const cover = container.querySelector<HTMLImageElement>('.node-cover img')!;
  expect(cover.getAttribute('src')).toBe('picboard://asset-thumb/c1/a1');
  expect(cover.getAttribute('loading')).toBe('lazy');
  expect(cover.getAttribute('decoding')).toBe('async');
  expect(cover.classList.contains('loaded')).toBe(false);
  fireEvent.load(cover);
  expect(cover.classList.contains('loaded')).toBe(true);
  expect(container.querySelector('.node-text-inner')?.textContent).toContain('带图正文');
});
