// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CanvasStage } from '../renderer/src/canvas/CanvasStage';
import { DEFAULT_CANVAS_APPEARANCE } from '../renderer/src/canvas/canvas-appearance';
import type { AppState, CanvasRecord, ContentRecord } from '../shared/image-board';

const ISO = '2026-01-01T00:00:00.000Z';

const content: ContentRecord = {
  id: 'c1',
  kind: 'text',
  preview: '拖动的节点',
  textLength: 5,
  url: null,
  image: null,
  coverAsset: null,
  categoryId: null,
  source: 'clipboard',
  createdAt: ISO,
  updatedAt: ISO,
  lastUsedAt: ISO,
};

const canvas: CanvasRecord = {
  id: 'root',
  name: '主画布',
  parentId: null,
  frame: null,
  nodes: [{ id: 'n1', contentId: 'c1', x: 100, y: 100, width: 280, height: 96 }],
  createdAt: ISO,
  viewport: { x: 0, y: 0, zoom: 1 },
};

const state = {
  revision: 1,
  activeCanvasId: 'root',
  canvases: [canvas],
  categories: [],
  contents: { c1: content },
  edges: [],
} as AppState;

beforeEach(() => {
  // jsdom has no PointerEvent; the plain Event fallback would drop clientX/pointerId.
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
  document.elementsFromPoint = () => [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});

afterEach(cleanup);

function mountStage(overrides: Partial<React.ComponentProps<typeof CanvasStage>> = {}) {
  const onNodesMove = vi.fn();
  const props: React.ComponentProps<typeof CanvasStage> = {
    state,
    canvas,
    contents: state.contents,
    initialViewport: { x: 0, y: 0, zoom: 1 },
    busy: false,
    snapToGrid: false,
    gridSize: 24,
    appearance: DEFAULT_CANVAS_APPEARANCE,
    spawnFrom: null,
    enterMotion: 'flat',
    selectedNodeIds: [],
    selectedCardId: null,
    selectedEdgeIds: [],
    focusRequest: null,
    onSelectNode: vi.fn(),
    onSelectNodes: vi.fn(),
    onSelectCard: vi.fn(),
    onSelectEdge: vi.fn(),
    onOpenContent: vi.fn(),
    onOpenCanvas: vi.fn(),
    onNodeActions: vi.fn(),
    onCardMenu: vi.fn(),
    onEdgeMenu: vi.fn(),
    onCanvasContextMenu: vi.fn(),
    onNodesMove,
    onNodesDrop: vi.fn(),
    onCardMove: vi.fn(),
    onEdgeCreate: vi.fn(),
    onViewport: vi.fn(),
    onZoomChange: vi.fn(),
    onInteractionChange: vi.fn(),
    ...overrides,
  };
  render(<CanvasStage {...props} />);
  const node = document.querySelector<HTMLElement>('.canvas-node')!;
  return { props, node, onNodesMove };
}

function drag(node: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, altKey = false) {
  fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(node, { pointerId: 1, clientX: to.x, clientY: to.y, altKey });
}

test('a drag writes the offset synchronously and never scales the translation', () => {
  const { node } = mountStage({ snapToGrid: false });
  drag(node, { x: 50, y: 50 }, { x: 60, y: 70 });
  expect(node.classList.contains('dragging')).toBe(true);
  // Individual translate is applied before the lift scale, so the offset is
  // exact; putting it in transform would multiply it by scale (1.03).
  expect(node.style.translate).toBe('10px 20px');
  expect(node.style.transform).toBe('');
});

test('snap mode lands the dragged set top-left on the grid and sends the snapped positions', () => {
  const { node, onNodesMove } = mountStage({ snapToGrid: true, gridSize: 24 });
  drag(node, { x: 50, y: 50 }, { x: 60, y: 60 });
  // Raw top-left (110,110) snaps to the nearest 24 grid line (120,120).
  expect(node.style.translate).toBe('20px 20px');
  expect(node.classList.contains('snap-drag')).toBe(true);
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 60, clientY: 60 });
  expect(onNodesMove).toHaveBeenCalledTimes(1);
  expect(onNodesMove).toHaveBeenCalledWith([{ id: 'n1', x: 120, y: 120 }]);
});

test('holding Alt inverts snapping for the gesture', () => {
  const { node, onNodesMove } = mountStage({ snapToGrid: true, gridSize: 24 });
  drag(node, { x: 50, y: 50 }, { x: 60, y: 60 }, true);
  expect(node.style.translate).toBe('10px 10px');
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 60, clientY: 60, altKey: true });
  expect(onNodesMove).toHaveBeenCalledWith([{ id: 'n1', x: 110, y: 110 }]);
});

test('middle-button pan writes the world transform and only commits the viewport on release', () => {
  const { props } = mountStage({ snapToGrid: false });
  const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
  const world = document.querySelector<HTMLElement>('.canvas-world')!;
  fireEvent.pointerDown(viewport, { pointerId: 2, button: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 130, clientY: 115 });
  expect(world.style.transform).toBe('translate(30px, 15px) scale(1)');
  expect(viewport.style.backgroundSize).toBe('24px 24px');
  // Dots stay world-anchored: the pattern offset follows the same pan write.
  expect(viewport.style.backgroundPosition).toBe('18px 3px');
  expect(props.onViewport).not.toHaveBeenCalled();
  fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 130, clientY: 115 });
  expect(props.onViewport).toHaveBeenCalledWith({ x: 30, y: 15, zoom: 1 });
});
