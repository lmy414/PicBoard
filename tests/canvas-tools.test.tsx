// @vitest-environment jsdom
import React, { createRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { CanvasStage, type CanvasStageHandle, type CanvasStageProps } from '../renderer/src/canvas/CanvasStage';
import { DEFAULT_CANVAS_APPEARANCE } from '../renderer/src/canvas/canvas-appearance';
import type { AppState, CanvasRecord, ContentRecord } from '../shared/image-board';

const ISO = '2026-01-01T00:00:00.000Z';
const content: ContentRecord = {
  id: 'c1', kind: 'text', preview: '画布工具测试', textLength: 6,
  url: null, image: null, coverAsset: null, categoryId: null, source: 'clipboard',
  createdAt: ISO, updatedAt: ISO, lastUsedAt: ISO,
};
const canvas: CanvasRecord = {
  id: 'root', name: '主画布', parentId: null, frame: null, createdAt: ISO,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'n1', contentId: 'c1', x: 100, y: 100, width: 280, height: 96 },
    { id: 'n2', contentId: 'c1', x: 500, y: 100, width: 280, height: 96 },
  ],
};
const child: CanvasRecord = {
  ...canvas, id: 'child', name: '子画布', parentId: 'root', nodes: [],
  frame: { x: 100, y: 300, width: 280, height: 140 },
};
const state = {
  revision: 1, activeCanvasId: 'root', canvases: [canvas, child], categories: [],
  contents: { c1: content }, edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2', createdAt: ISO }],
} as AppState;

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventPolyfill);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = () => true;
  document.elementsFromPoint = () => [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountStage(overrides: Partial<CanvasStageProps> = {}) {
  let props: CanvasStageProps = {
    state, canvas, contents: state.contents, initialViewport: canvas.viewport!, busy: false,
    snapToGrid: false, gridSize: 24, appearance: DEFAULT_CANVAS_APPEARANCE,
    spawnFrom: null, enterMotion: 'flat', selectedNodeIds: [], selectedCardId: null,
    selectedEdgeIds: [], focusRequest: null,
    onSelectNode: vi.fn(), onSelectNodes: vi.fn(), onSelectCard: vi.fn(), onSelectEdge: vi.fn(),
    onOpenContent: vi.fn(), onOpenCanvas: vi.fn(), onNodeActions: vi.fn(), onCardMenu: vi.fn(),
    onEdgeMenu: vi.fn(), onCanvasContextMenu: vi.fn(), onNodesMove: vi.fn(), onNodesDrop: vi.fn(),
    onCardMove: vi.fn(), onEdgeCreate: vi.fn(), onViewport: vi.fn(), onZoomChange: vi.fn(),
    onInteractionChange: vi.fn(), ...overrides,
  };
  const ref = createRef<CanvasStageHandle>();
  const view = render(<CanvasStage {...props} ref={ref} />);
  const viewport = view.container.querySelector<HTMLElement>('.canvas-viewport')!;
  return {
    props, ref, view, viewport,
    world: viewport.querySelector<HTMLElement>('.canvas-world')!,
    node: viewport.querySelector<HTMLElement>('[data-node-id="n1"]')!,
    card: viewport.querySelector<HTMLElement>('.canvas-node-card')!,
    handle: viewport.querySelector<HTMLElement>('.node-handle')!,
    edge: viewport.querySelector<SVGPathElement>('.edge-hit')!,
    update(next: Partial<CanvasStageProps>) {
      props = { ...props, ...next };
      view.rerender(<CanvasStage {...props} ref={ref} />);
    },
  };
}

function pointerDown(target: Element, button = 0, pointerId = 1) {
  fireEvent.pointerDown(target, { pointerId, button, clientX: 100, clientY: 100 });
}
function pointerMove(target: Element, pointerId = 1) {
  fireEvent.pointerMove(target, { pointerId, clientX: 145, clientY: 125 });
}
function pointerUp(target: Element, pointerId = 1) {
  fireEvent.pointerUp(target, { pointerId, clientX: 145, clientY: 125 });
}
function flushFrames() {
  act(() => {
    for (let i = 0; frames.size && i < 100; i++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    }
  });
}

// SVG edge hits and nodes normally consume pointerdown before it bubbles.
// The hand tool must win over those handlers, including nested card content.
test.each(['viewport', 'node', 'card', 'card-body', 'handle', 'edge'] as const)(
  'pan mode starts on %s without selecting, moving or connecting content', (start) => {
    const stage = mountStage({ interactionMode: 'pan' });
    const target = start === 'card-body' ? stage.card.querySelector('.canvas-node-body')! : stage[start];
    expect(stage.viewport.style.cursor).toBe('grab');
    pointerDown(target);
    expect(stage.viewport.style.cursor).toBe('grabbing');
    expect(stage.viewport.classList.contains('is-panning')).toBe(true);
    pointerMove(stage.viewport);
    expect(stage.world.style.transform).toBe('translate(45px, 25px) scale(1)');
    expect(stage.node.style.translate).toBe('');
    expect(stage.card.style.translate).toBe('');
    expect(stage.viewport.querySelector('.connect-path.active')).toBeNull();
    expect(stage.props.onViewport).not.toHaveBeenCalled();
    pointerUp(stage.viewport);
    fireEvent.click(target);
    fireEvent.doubleClick(target);
    expect(stage.props.onViewport).toHaveBeenCalledWith({ x: 45, y: 25, zoom: 1 });
    expect(stage.props.onInteractionChange).toHaveBeenNthCalledWith(1, true);
    expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
    expect(stage.viewport.style.cursor).toBe('grab');
    for (const callback of [stage.props.onSelectNode, stage.props.onSelectNodes, stage.props.onSelectCard,
      stage.props.onSelectEdge, stage.props.onNodesMove, stage.props.onNodesDrop, stage.props.onCardMove,
      stage.props.onEdgeCreate, stage.props.onOpenContent, stage.props.onOpenCanvas, stage.props.onCardMenu]) {
      expect(callback).not.toHaveBeenCalled();
    }
  },
);

test('omitting interactionMode preserves selection, node dragging, opening and connection creation', () => {
  const stage = mountStage();
  pointerDown(stage.node);
  pointerMove(stage.node);
  pointerUp(stage.node);
  expect(stage.props.onSelectNode).toHaveBeenCalledWith('n1', false);
  expect(stage.props.onNodesMove).toHaveBeenCalledWith([{ id: 'n1', x: 145, y: 125 }]);
  fireEvent.doubleClick(stage.node);
  expect(stage.props.onOpenContent).toHaveBeenCalledWith('c1', stage.node);
  fireEvent.doubleClick(stage.card);
  expect(stage.props.onOpenCanvas).toHaveBeenCalledWith('child');
  const target = stage.viewport.querySelector<HTMLElement>('[data-node-id="n2"]')!;
  document.elementsFromPoint = () => [target];
  pointerDown(stage.handle);
  pointerMove(stage.handle);
  pointerUp(stage.handle);
  expect(stage.props.onEdgeCreate).toHaveBeenCalledWith('n1', 'n2');
  expect(stage.world.style.transform).toBe('translate(0px, 0px) scale(1)');
});

test.each(['select', 'pan'] as const)('middle-button panning works from a connector in %s mode', (mode) => {
  const stage = mountStage({ interactionMode: mode });
  pointerDown(stage.handle, 1);
  pointerMove(stage.viewport);
  pointerUp(stage.viewport);
  expect(stage.props.onViewport).toHaveBeenCalledWith({ x: 45, y: 25, zoom: 1 });
  expect(stage.props.onEdgeCreate).not.toHaveBeenCalled();
  expect(stage.props.onSelectNode).not.toHaveBeenCalled();
});

test('Space temporarily pans from a handle and suppresses the click after Space is released', () => {
  const stage = mountStage();
  fireEvent.keyDown(stage.node, { code: 'Space', key: ' ' });
  expect(stage.viewport.classList.contains('hand-tool')).toBe(true);
  pointerDown(stage.handle);
  pointerMove(stage.viewport);
  // Keyup can target an editor after focus changes; it must still release Space.
  const input = document.createElement('input');
  document.body.append(input);
  fireEvent.keyUp(input, { code: 'Space', key: ' ' });
  input.remove();
  expect(stage.viewport.classList.contains('hand-tool')).toBe(false);
  expect(stage.viewport.style.cursor).toBe('grabbing');
  pointerUp(stage.viewport);
  fireEvent.doubleClick(stage.node);
  expect(stage.props.onOpenContent).not.toHaveBeenCalled();
  expect(stage.props.onEdgeCreate).not.toHaveBeenCalled();
  expect(stage.viewport.style.cursor).toBe('');
  pointerDown(stage.node);
  pointerMove(stage.node);
  pointerUp(stage.node);
  expect(stage.props.onNodesMove).toHaveBeenCalledTimes(1);
  fireEvent.doubleClick(stage.node);
  expect(stage.props.onOpenContent).toHaveBeenCalledTimes(1);
});

test('blur restores Space and ends panning even when the Space keyup is lost', () => {
  const stage = mountStage();
  fireEvent.keyDown(stage.node, { code: 'Space', key: ' ' });
  pointerDown(stage.node);
  pointerMove(stage.viewport);
  fireEvent.blur(window);
  expect(stage.viewport.classList.contains('hand-tool')).toBe(false);
  expect(stage.viewport.classList.contains('is-panning')).toBe(false);
  expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
  pointerDown(stage.node);
  pointerMove(stage.node);
  pointerUp(stage.node);
  expect(stage.props.onNodesMove).toHaveBeenCalledTimes(1);
});

test.each(['pointercancel', 'lostpointercapture', 'Escape', 'mode-switch'] as const)(
  '%s ends pan, retains its visible viewport and ignores stale pointer events', (end) => {
    const stage = mountStage({ interactionMode: 'pan' });
    pointerDown(stage.node);
    pointerMove(stage.viewport);
    if (end === 'pointercancel') fireEvent.pointerCancel(stage.viewport, { pointerId: 1 });
    if (end === 'lostpointercapture') fireEvent.lostPointerCapture(stage.viewport, { pointerId: 1 });
    if (end === 'Escape') fireEvent.keyDown(stage.viewport, { key: 'Escape' });
    if (end === 'mode-switch') stage.update({ interactionMode: 'select' });
    expect(stage.viewport.classList.contains('is-panning')).toBe(false);
    expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
    expect(stage.props.onViewport).toHaveBeenCalledTimes(1);
    expect(stage.props.onViewport).toHaveBeenCalledWith({ x: 45, y: 25, zoom: 1 });
    fireEvent.pointerMove(stage.viewport, { pointerId: 1, clientX: 300, clientY: 300 });
    pointerUp(stage.viewport);
    expect(stage.world.style.transform).toBe('translate(45px, 25px) scale(1)');
    expect(stage.props.onViewport).toHaveBeenCalledTimes(1);
  },
);

test.each(['node', 'card', 'handle', 'viewport'] as const)(
  'switching to pan abandons an unfinished %s edit and allows a new pan', (start) => {
    const stage = mountStage({ interactionMode: 'select' });
    pointerDown(stage[start]);
    pointerMove(stage[start]);
    stage.update({ interactionMode: 'pan' });
    pointerUp(stage[start]);
    expect(stage.node.style.translate).toBe('');
    expect(stage.node.style.left).toBe('100px');
    expect(stage.card.style.translate).toBe('');
    expect(stage.card.style.top).toBe('300px');
    expect(stage.node.classList.contains('dragging')).toBe(false);
    expect(stage.card.classList.contains('dragging')).toBe(false);
    expect(stage.viewport.querySelector('.selection-rect')).toBeNull();
    expect(stage.viewport.querySelector('.connect-path.active')).toBeNull();
    expect(stage.props.onNodesMove).not.toHaveBeenCalled();
    expect(stage.props.onCardMove).not.toHaveBeenCalled();
    expect(stage.props.onEdgeCreate).not.toHaveBeenCalled();
    expect(stage.props.onSelectNodes).not.toHaveBeenCalled();
    expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
    pointerDown(stage.node, 0, 2);
    pointerMove(stage.viewport, 2);
    pointerUp(stage.viewport, 2);
    expect(stage.props.onViewport).toHaveBeenCalledWith({ x: 45, y: 25, zoom: 1 });
  },
);

test('losing selection capture abandons the selection instead of committing it', () => {
  const stage = mountStage();
  pointerDown(stage.viewport);
  pointerMove(stage.viewport);
  expect(stage.viewport.querySelector('.selection-rect')).not.toBeNull();
  fireEvent.lostPointerCapture(stage.viewport, { pointerId: 1 });
  pointerUp(stage.viewport);
  expect(stage.viewport.querySelector('.selection-rect')).toBeNull();
  expect(stage.props.onSelectNodes).not.toHaveBeenCalled();
  expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
});

test.each(['input', 'textarea', 'select', 'contenteditable'] as const)(
  'Space and pointer events in %s remain available to editing controls in pan mode', (kind) => {
    const stage = mountStage({ interactionMode: 'pan' });
    const editable = document.createElement(kind === 'contenteditable' ? 'div' : kind);
    if (kind === 'contenteditable') editable.setAttribute('contenteditable', 'true');
    stage.viewport.append(editable);
    expect(fireEvent.keyDown(editable, { code: 'Space', key: ' ', cancelable: true })).toBe(true);
    expect(fireEvent.pointerDown(editable, { pointerId: 1, button: 0, cancelable: true })).toBe(true);
    pointerMove(stage.viewport);
    pointerUp(stage.viewport);
    expect(stage.viewport.classList.contains('is-panning')).toBe(false);
    expect(stage.props.onInteractionChange).not.toHaveBeenCalled();
    expect(stage.props.onViewport).not.toHaveBeenCalled();
    // After leaving pan, typing Space must not have left the temporary hand on.
    stage.update({ interactionMode: 'select' });
    expect(stage.viewport.classList.contains('hand-tool')).toBe(false);
  },
);

test('pan mode preserves wheel zoom and does not zoom while a pointer pan is active', () => {
  const stage = mountStage({ interactionMode: 'pan' });
  fireEvent.wheel(stage.viewport, { deltaY: -100, clientX: 100, clientY: 100 });
  flushFrames();
  expect(stage.ref.current!.importViewport()!.zoom).toBeCloseTo(Math.exp(0.15));
  expect(stage.props.onZoomChange).toHaveBeenLastCalledWith(Math.exp(0.15));
  pointerDown(stage.node);
  fireEvent.wheel(stage.viewport, { deltaY: -100, clientX: 100, clientY: 100 });
  expect(frames.size).toBe(0);
  pointerMove(stage.viewport);
  pointerUp(stage.viewport);
  expect(stage.ref.current!.importViewport()!.zoom).toBeCloseTo(Math.exp(0.15));
});

test('a failed pan capture does not leave the stage busy or consume a later selection drag', () => {
  const stage = mountStage({ interactionMode: 'pan' });
  stage.viewport.setPointerCapture = () => { throw new DOMException('pointer ended', 'NotFoundError'); };
  pointerDown(stage.node);
  pointerMove(stage.viewport);
  expect(stage.viewport.style.cursor).toBe('grab');
  expect(stage.props.onInteractionChange).not.toHaveBeenCalled();
  expect(stage.world.style.transform).toBe('translate(0px, 0px) scale(1)');
  stage.update({ interactionMode: 'select' });
  pointerDown(stage.node);
  pointerMove(stage.node);
  pointerUp(stage.node);
  expect(stage.props.onNodesMove).toHaveBeenCalledTimes(1);
});

test('hiding the document clears a held Space key and cancels an active selection', () => {
  const stage = mountStage();
  pointerDown(stage.viewport);
  pointerMove(stage.viewport);
  fireEvent.keyDown(stage.viewport, { code: 'Space', key: ' ' });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  expect(stage.viewport.classList.contains('hand-tool')).toBe(false);
  expect(stage.viewport.querySelector('.selection-rect')).toBeNull();
  expect(stage.props.onSelectNodes).not.toHaveBeenCalled();
  expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
});

test('pan mode leaves mini-map navigation available', () => {
  const stage = mountStage({ interactionMode: 'pan' });
  const map = stage.viewport.querySelector<HTMLElement>('.mini-map')!;
  pointerDown(map);
  pointerMove(map);
  pointerUp(map);
  expect(stage.props.onViewport).toHaveBeenCalledTimes(1);
  expect(stage.viewport.classList.contains('is-panning')).toBe(false);
  expect(stage.props.onSelectNodes).not.toHaveBeenCalled();
});

test('unmount during pan clears the interaction state', () => {
  const stage = mountStage({ interactionMode: 'pan' });
  pointerDown(stage.node);
  pointerMove(stage.viewport);
  stage.view.unmount();
  expect(stage.props.onInteractionChange).toHaveBeenLastCalledWith(false);
  expect(stage.props.onViewport).toHaveBeenCalledWith({ x: 45, y: 25, zoom: 1 });
});
