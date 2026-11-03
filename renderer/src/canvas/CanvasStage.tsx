import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AppState,
  CanvasFrame,
  CanvasNode,
  CanvasPoint,
  CanvasRecord,
  CanvasViewport,
  ContentRecord,
  GridSize,
  ImportViewport,
} from "../../../shared/image-board";
import { itemsInSelectionRect, normalizeSelectionRect, type SelectionRect } from "../../../shared/canvas-selection";
import { resolveCanvasEdges, type ResolvedEdge } from "../../../shared/edge-geometry";
import { isSnapActive, snappedDelta } from "../../../shared/grid-snap";
import { MINIMAP_MIN_CANVAS } from "../ui/breakpoints";
import { cubicBezierProgress } from "../ui/motion";
import { CanvasNodeCard } from "./CanvasNodeCard";
import { CanvasNodeView, type EdgeSide } from "./CanvasNodeView";
import { patternInk, type CanvasAppearance } from "./canvas-appearance";
import { EdgeLayer, type EdgeLayerHandle } from "./EdgeLayer";
import { MiniMap } from "./MiniMap";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;
/** Relocation FLIP and item-exit durations (CSS exit is 120 ms). */
const FLIP_MS = 240;
const EXIT_MS = 140;

export interface CanvasStageHandle {
  containsClient(clientX: number, clientY: number): boolean;
  /** Until the resize burst settles, keep the world fixed to the window's right edge instead of the viewport center (sidebar width animations). */
  beginWindowAnchoredResize(): void;
  /** Live world point, using the in-flight glide target when one is running. */
  worldPoint(clientX: number, clientY: number): CanvasPoint | null;
  /** Viewport snapshot for host import commands (place content in view). */
  importViewport(): ImportViewport | null;
  zoomBy(delta: number): void;
  locateAll(): boolean;
  /** Play scale/fade exits for items the host is about to remove; resolves after the exit. */
  playExit(input: { nodeIds?: string[]; edgeIds?: string[]; cardIds?: string[] }): Promise<void>;
}

export interface CanvasStageProps {
  state: AppState;
  canvas: CanvasRecord;
  contents: Record<string, ContentRecord>;
  initialViewport: CanvasViewport;
  busy: boolean;
  /** Left-button tool; middle-button and Space panning work in either mode. */
  interactionMode?: "select" | "pan";
  snapToGrid: boolean;
  gridSize: GridSize;
  appearance: CanvasAppearance;
  /** World point new nodes should glide in from (drop point / viewport center). */
  spawnFrom: { point: CanvasPoint; nonce: number } | null;
  /** Sub-canvas navigation direction for the world zoom/crossfade. */
  enterMotion: "into" | "out" | "flat";
  selectedNodeIds: string[];
  selectedCardId: string | null;
  selectedEdgeIds: string[];
  focusRequest: { nodeId: string; nonce: number } | null;
  onSelectNode(nodeId: string, toggle: boolean): void;
  onSelectNodes(nodeIds: string[], additive: boolean): void;
  onSelectCard(canvasId: string | null): void;
  onSelectEdge(edgeId: string, toggle: boolean): void;
  onOpenContent(contentId: string, origin: HTMLElement | null): void;
  onOpenCanvas(canvasId: string): void;
  onNodeActions(event: React.MouseEvent<HTMLElement> | null, nodeId: string): void;
  onCardMenu(event: React.MouseEvent<HTMLElement> | null, canvasId: string): void;
  onEdgeMenu(edgeId: string, clientX: number, clientY: number): void;
  /** Right click on genuinely empty canvas space; nodes, cards, edges and the mini-map never call it. */
  onCanvasContextMenu(clientX: number, clientY: number): void;
  onNodesMove(positions: Array<{ id: string; x: number; y: number }>): void;
  onNodesDrop(nodeIds: string[], cardId: string): void;
  onCardMove(canvasId: string, frame: CanvasFrame): void;
  onEdgeCreate(fromNodeId: string, toNodeId: string): void;
  onViewport(viewport: CanvasViewport): void;
  onZoomChange(zoom: number): void;
  onInteractionChange(busy: boolean): void;
}

interface PanSession {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface SelectSession {
  pointerId: number;
  start: CanvasPoint;
  additive: boolean;
  rect: SelectionRect | null;
}

interface NodeDragSession {
  pointerId: number;
  nodeId: string;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
  collapseOnClick: boolean;
  moving: Array<{ id: string; x: number; y: number }>;
  /** Bounding top-left of the moving set; snapping targets this origin. */
  originX: number;
  originY: number;
  snapping: boolean;
  cardId: string | null;
  clientX: number;
  clientY: number;
}

interface CardDragSession {
  pointerId: number;
  canvasId: string;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
  snapping: boolean;
  frame: CanvasFrame;
}

interface ConnectSession {
  pointerId: number;
  fromNodeId: string;
  start: CanvasPoint;
  targetId: string | null;
  element: HTMLElement;
  cleanup: () => void;
}

const isEditable = (target: EventTarget | null): boolean => {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.isContentEditable || element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .ProseMirror'));
};

const clampZoom = (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * `setPointerCapture` throws NotFoundError when the pointer already ended (for
 * example a synthetic or coalesced event). The gesture must then be abandoned
 * instead of leaving a session without events.
 */
function capturePointer(element: Element | null, pointerId: number): boolean {
  try {
    if (!element) return false;
    element.setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

const sidePoint = (node: CanvasNode, side: EdgeSide): CanvasPoint => {
  if (side === "top") return { x: node.x + node.width / 2, y: node.y };
  if (side === "bottom") return { x: node.x + node.width / 2, y: node.y + node.height };
  if (side === "left") return { x: node.x, y: node.y + node.height / 2 };
  return { x: node.x + node.width, y: node.y + node.height / 2 };
};

/**
 * Infinite canvas surface. Pan, zoom glides, box selection, node/card drags
 * and edge drawing all write the DOM directly; React state changes only on
 * gesture commit, so pointer-move hot paths never re-render the scene.
 */
export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(function CanvasStage(props, ref) {
  const { canvas, state, contents } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const connectPathRef = useRef<SVGPathElement>(null);
  const edgeLayerRef = useRef<EdgeLayerHandle>(null);
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const cardElements = useRef(new Map<string, HTMLElement>());
  const displayedRef = useRef(new Map<string, { x: number; y: number }>());
  const viewportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const viewportSyncTimerRef = useRef<number | undefined>(undefined);
  const backgroundSizeRef = useRef("");
  const positionsInitializedRef = useRef(false);
  const flipRafRef = useRef<number | null>(null);
  const usedSpawnNonceRef = useRef(0);
  const edgesRef = useRef<ResolvedEdge[]>([]);

  const initial = Number.isFinite(props.initialViewport.zoom) && props.initialViewport.zoom > 0
    ? props.initialViewport
    : { x: 0, y: 0, zoom: 1 };
  const [offset, setOffset] = useState({ x: initial.x, y: initial.y });
  const [zoom, setZoom] = useState(initial.zoom);
  const [spacePressed, setSpacePressed] = useState(false);
  const [panning, setPanning] = useState(false);
  const interactionMode = props.interactionMode ?? "select";
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const [canvasWide, setCanvasWide] = useState(true);

  const offsetRef = useRef(offset);
  const zoomRef = useRef(zoom);
  const spaceRef = useRef(false);
  const panRef = useRef<PanSession | null>(null);
  // A Space release or tool switch can precede the browser's trailing click.
  const suppressPanClickRef = useRef(false);
  const previousModeRef = useRef(interactionMode);
  const selectRef = useRef<SelectSession | null>(null);
  const nodeDragRef = useRef<NodeDragSession | null>(null);
  const cardDragRef = useRef<CardDragSession | null>(null);
  const connectRef = useRef<ConnectSession | null>(null);
  // "right" keeps the world fixed relative to the window while the sidebar
  // animates its width (only the viewport's left edge moves); the RO resets
  // it to "center" once the resize burst settles.
  const resizeAnchorXRef = useRef<"center" | "right">("center");
  const glideRef = useRef<{ raf: number; targetOffset: { x: number; y: number }; targetZoom: number } | null>(null);
  const interactionRef = useRef(false);

  const propsRef = useRef(props);
  propsRef.current = props;
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const selectedNodeIdsRef = useRef(props.selectedNodeIds);
  selectedNodeIdsRef.current = props.selectedNodeIds;

  const cards = useMemo(
    () => state.canvases.filter((item) => item.parentId === canvas.id && item.frame !== null),
    [state.canvases, canvas.id],
  );
  const nodes = useMemo(
    () => canvas.nodes.filter((node) => Boolean(contents[node.contentId])),
    [canvas.nodes, contents],
  );
  const edges = useMemo(() => resolveCanvasEdges(state, canvas.id), [state, canvas.id]);
  edgesRef.current = edges;
  const selectedNodeSet = useMemo(() => new Set(props.selectedNodeIds), [props.selectedNodeIds]);

  const syncBusy = useCallback(() => {
    const busy = Boolean(panRef.current || selectRef.current || nodeDragRef.current || cardDragRef.current || connectRef.current || glideRef.current);
    if (busy === interactionRef.current) return;
    interactionRef.current = busy;
    propsRef.current.onInteractionChange(busy);
  }, []);

  const applyWorldTransform = useCallback((nextOffset: { x: number; y: number }, nextZoom: number) => {
    // A non-finite offset/zoom (bad host payload, degenerate measurement) would
    // poison every later transform and background write; keep the last good one.
    if (!Number.isFinite(nextOffset.x) || !Number.isFinite(nextOffset.y) || !Number.isFinite(nextZoom) || nextZoom <= 0) return;
    offsetRef.current = nextOffset;
    zoomRef.current = nextZoom;
    const world = worldRef.current;
    if (world) world.style.transform = `translate(${nextOffset.x}px, ${nextOffset.y}px) scale(${nextZoom})`;
    // The grid pattern is world-anchored in the same DOM write. background-*
    // are paint-only and non-inherited: panning never recalcs the subtree or
    // forces layout. The size only changes with zoom.
    const viewport = viewportRef.current;
    if (viewport) {
      const size = Math.max(1, propsRef.current.gridSize * nextZoom);
      const sizeText = `${size}px ${size}px`;
      if (sizeText !== backgroundSizeRef.current) {
        backgroundSizeRef.current = sizeText;
        viewport.style.backgroundSize = sizeText;
      }
      const pattern = propsRef.current.appearance.pattern;
      const shift = pattern === "dots" ? size / 2 : 0;
      const positionX = ((nextOffset.x - shift) % size + size) % size;
      const positionY = ((nextOffset.y - shift) % size + size) % size;
      viewport.style.backgroundPosition = `${positionX}px ${positionY}px`;
    }
  }, []);

  const commitViewport = useCallback((nextOffset: { x: number; y: number }, nextZoom: number) => {
    applyWorldTransform(nextOffset, nextZoom);
    setOffset(nextOffset);
    setZoom(nextZoom);
    propsRef.current.onViewport({ x: nextOffset.x, y: nextOffset.y, zoom: nextZoom });
    propsRef.current.onZoomChange(nextZoom);
  }, [applyWorldTransform]);

  const stopGlide = useCallback(() => {
    const glide = glideRef.current;
    if (!glide) return;
    cancelAnimationFrame(glide.raf);
    glideRef.current = null;
  }, []);

  /** Adopt the glide's live position before a gesture takes over the world. */
  const settleGlide = useCallback(() => {
    if (!glideRef.current) return;
    stopGlide();
    setOffset(offsetRef.current);
    setZoom(zoomRef.current);
  }, [stopGlide]);

  const glideStep = useCallback(() => {
    const glide = glideRef.current;
    if (!glide) return;
    const current = offsetRef.current;
    const nextZoom = zoomRef.current + (glide.targetZoom - zoomRef.current) * 0.3;
    const nextOffset = {
      x: current.x + (glide.targetOffset.x - current.x) * 0.3,
      y: current.y + (glide.targetOffset.y - current.y) * 0.3,
    };
    const settled = Math.abs(glide.targetZoom - nextZoom) < 0.0008
      && Math.abs(glide.targetOffset.x - nextOffset.x) < 0.5
      && Math.abs(glide.targetOffset.y - nextOffset.y) < 0.5;
    applyWorldTransform(settled ? glide.targetOffset : nextOffset, settled ? glide.targetZoom : nextZoom);
    if (settled) {
      glideRef.current = null;
      commitViewport(glide.targetOffset, glide.targetZoom);
      syncBusy();
      return;
    }
    glide.raf = requestAnimationFrame(glideStep);
  }, [applyWorldTransform, commitViewport, syncBusy]);

  const beginGlide = useCallback((targetOffset: { x: number; y: number }, targetZoom: number) => {
    stopGlide();
    glideRef.current = { raf: requestAnimationFrame(glideStep), targetOffset, targetZoom };
    syncBusy();
  }, [glideStep, stopGlide, syncBusy]);

  const worldPointFromClient = useCallback((clientX: number, clientY: number): CanvasPoint | null => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const base = glideRef.current?.targetOffset ?? offsetRef.current;
    const baseZoom = glideRef.current?.targetZoom ?? zoomRef.current;
    return { x: (clientX - rect.left - base.x) / baseZoom, y: (clientY - rect.top - base.y) / baseZoom };
  }, []);

  const reducedMotion = (): boolean => typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clearFlip = useCallback(() => {
    if (flipRafRef.current !== null) {
      cancelAnimationFrame(flipRafRef.current);
      flipRafRef.current = null;
    }
    edgeLayerRef.current?.clearOffsets();
    for (const element of nodeElements.current.values()) element.style.translate = "";
    for (const element of cardElements.current.values()) element.style.translate = "";
  }, []);

  /** FLIP: the DOM already holds the final position; glide from the shown one. */
  const runFlip = useCallback((items: Array<{ key: string; element: HTMLElement; dx: number; dy: number }>) => {
    if (items.length === 0 || reducedMotion()) return;
    for (const item of items) item.element.style.translate = `${item.dx}px ${item.dy}px`;
    edgeLayerRef.current?.applyOffsets(new Map(items.map((item) => [item.key, { dx: item.dx, dy: item.dy }])));
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / FLIP_MS);
      const factor = 1 - cubicBezierProgress(0.16, 1, 0.3, 1, progress);
      const offsets = new Map<string, { dx: number; dy: number }>();
      for (const item of items) {
        const dx = item.dx * factor;
        const dy = item.dy * factor;
        offsets.set(item.key, { dx, dy });
        if (item.element.isConnected) item.element.style.translate = dx === 0 && dy === 0 ? "" : `${dx}px ${dy}px`;
      }
      edgeLayerRef.current?.applyOffsets(offsets);
      if (progress < 1) {
        flipRafRef.current = requestAnimationFrame(step);
        return;
      }
      flipRafRef.current = null;
      for (const item of items) if (item.element.isConnected) item.element.style.translate = "";
      edgeLayerRef.current?.clearOffsets();
    };
    flipRafRef.current = requestAnimationFrame(step);
  }, []);

  // Reconcile world positions after every render: relocated nodes/cards glide
  // from where the screen showed them, with edges following in the same frames.
  const reconcilePositions = () => {
    if (!positionsInitializedRef.current) {
      displayedRef.current.clear();
      for (const node of nodes) displayedRef.current.set(`node:${node.id}`, { x: node.x, y: node.y });
      for (const card of cards) if (card.frame) displayedRef.current.set(`card:${card.id}`, { x: card.frame.x, y: card.frame.y });
      positionsInitializedRef.current = true;
      if (props.spawnFrom) usedSpawnNonceRef.current = props.spawnFrom.nonce;
      return;
    }
    const next = new Map<string, { x: number; y: number }>();
    const moves: Array<{ key: string; element: HTMLElement; dx: number; dy: number }> = [];
    for (const node of nodes) {
      const key = `node:${node.id}`;
      next.set(key, { x: node.x, y: node.y });
      const previous = displayedRef.current.get(key);
      const element = nodeElements.current.get(node.id);
      if (previous && element && (previous.x !== node.x || previous.y !== node.y)) {
        moves.push({ key, element, dx: previous.x - node.x, dy: previous.y - node.y });
      }
    }
    for (const card of cards) {
      if (!card.frame) continue;
      const key = `card:${card.id}`;
      next.set(key, { x: card.frame.x, y: card.frame.y });
      const previous = displayedRef.current.get(key);
      const element = cardElements.current.get(card.id);
      if (previous && element && (previous.x !== card.frame.x || previous.y !== card.frame.y)) {
        moves.push({ key, element, dx: previous.x - card.frame.x, dy: previous.y - card.frame.y });
      }
    }
    const spawn = props.spawnFrom;
    if (spawn && spawn.nonce !== usedSpawnNonceRef.current) {
      usedSpawnNonceRef.current = spawn.nonce;
      for (const node of nodes) {
        const key = `node:${node.id}`;
        if (displayedRef.current.has(key)) continue;
        const element = nodeElements.current.get(node.id);
        if (element) moves.push({ key, element, dx: spawn.point.x - node.x, dy: spawn.point.y - node.y });
      }
    }
    displayedRef.current = next;
    if (interactionRef.current || moves.length === 0) return;
    clearFlip();
    runFlip(moves);
  };

  /** Exit before the host removes: scale/fade and fade touching edges. */
  const playExit = useCallback((input: { nodeIds?: string[]; edgeIds?: string[]; cardIds?: string[] }) => {
    // A relocation glide must not fight the exit transforms.
    clearFlip();
    const nodeIds = input.nodeIds ?? [];
    const cardIds = input.cardIds ?? [];
    const edgeIds = new Set(input.edgeIds ?? []);
    for (const edge of edgesRef.current) {
      if ((edge.from.kind === "node" && nodeIds.includes(edge.from.nodeId))
        || (edge.to.kind === "node" && nodeIds.includes(edge.to.nodeId))) {
        edgeIds.add(edge.edgeId);
      }
    }
    let touched = false;
    for (const id of nodeIds) {
      const element = nodeElements.current.get(id);
      if (!element) continue;
      element.setAttribute("data-node-exit", "true");
      touched = true;
    }
    for (const id of cardIds) {
      const element = cardElements.current.get(id);
      if (!element) continue;
      element.setAttribute("data-node-exit", "true");
      touched = true;
    }
    if (edgeIds.size > 0) {
      edgeLayerRef.current?.markExiting([...edgeIds]);
      touched = true;
    }
    // If the host rejects the change the items stay; restore them after a beat.
    window.setTimeout(() => {
      for (const id of nodeIds) nodeElements.current.get(id)?.removeAttribute("data-node-exit");
      for (const id of cardIds) cardElements.current.get(id)?.removeAttribute("data-node-exit");
      edgeLayerRef.current?.clearExiting();
    }, 1000);
    if (!touched) return Promise.resolve();
    return new Promise<void>((resolve) => {
      window.setTimeout(resolve, EXIT_MS);
    });
  }, [clearFlip]);

  useLayoutEffect(() => {
    reconcilePositions();
  });

  useLayoutEffect(() => {
    applyWorldTransform({ x: initial.x, y: initial.y }, initial.zoom);
    // The persisted viewport is the mount-time source of truth; later changes
    // come from this surface's own gestures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grid spacing and pattern changes keep the world-anchored background in sync.
  useLayoutEffect(() => {
    applyWorldTransform(offsetRef.current, zoomRef.current);
  }, [applyWorldTransform, props.appearance.pattern, props.gridSize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".mini-map, input, textarea, select, [contenteditable], .ProseMirror")) return;
      if (document.querySelector(".dialog-card")) return;
      // Zooming mid-drag would invalidate the drag's world-space mapping.
      if (nodeDragRef.current || cardDragRef.current || connectRef.current || panRef.current || selectRef.current) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const baseZoom = glideRef.current?.targetZoom ?? zoomRef.current;
      const nextZoom = clampZoom(baseZoom * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0015));
      if (nextZoom === baseZoom) return;
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const baseOffset = glideRef.current?.targetOffset ?? offsetRef.current;
      const ratio = nextZoom / baseZoom;
      beginGlide({ x: point.x - (point.x - baseOffset.x) * ratio, y: point.y - (point.y - baseOffset.y) * ratio }, nextZoom);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", wheel);
      stopGlide();
      syncBusy();
      // Flush a live transform so canvas switches never lose the position.
      propsRef.current.onViewport({ x: offsetRef.current.x, y: offsetRef.current.y, zoom: zoomRef.current });
    };
  }, [beginGlide, stopGlide, syncBusy]);

  /** Keep navigation where it stopped, but abandon any unfinished content edits. */
  const cancelGestures = useCallback((): boolean => {
    const pan = panRef.current;
    const select = selectRef.current;
    const node = nodeDragRef.current;
    const card = cardDragRef.current;
    const connect = connectRef.current;
    if (!pan && !select && !node && !card && !connect) return false;
    panRef.current = null;
    selectRef.current = null;
    nodeDragRef.current = null;
    cardDragRef.current = null;
    connectRef.current = null;
    const release = (element: Element | null | undefined, pointerId: number) => {
      if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    setPanning(false);
    setSelectionRect(null);
    if (pan) {
      release(viewportRef.current, pan.pointerId);
      commitViewport(offsetRef.current, zoomRef.current);
    }
    if (select) release(viewportRef.current, select.pointerId);
    if (node) {
      if (node.cardId) cardElements.current.get(node.cardId)?.classList.remove("card-hover");
      for (const item of node.moving) {
        const element = nodeElements.current.get(item.id);
        if (!element) continue;
        element.classList.remove("dragging", "snap-drag");
        element.style.translate = "";
      }
      release(nodeElements.current.get(node.nodeId), node.pointerId);
    }
    if (card) {
      const element = cardElements.current.get(card.canvasId);
      if (element) {
        element.classList.remove("dragging", "snap-drag");
        element.style.translate = "";
      }
      release(element, card.pointerId);
    }
    if (node || card) edgeLayerRef.current?.endDrag();
    if (connect) {
      connect.cleanup();
      release(connect.element, connect.pointerId);
      if (connect.targetId) nodeElements.current.get(connect.targetId)?.classList.remove("connect-target");
      connectPathRef.current?.classList.remove("active");
      connectPathRef.current?.removeAttribute("d");
    }
    syncBusy();
    return true;
  }, [commitViewport, syncBusy]);

  useLayoutEffect(() => {
    if (previousModeRef.current === interactionMode) return;
    previousModeRef.current = interactionMode;
    cancelGestures();
  }, [interactionMode, cancelGestures]);

  useEffect(() => {
    const clearSpace = () => {
      spaceRef.current = false;
      setSpacePressed(false);
    };
    const down = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (event.key === "Escape") {
        if (cancelGestures()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.code !== "Space" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      spaceRef.current = true;
      setSpacePressed(true);
      // Do not scroll the page when Space is used on a focused canvas item.
      if (event.target instanceof Node && viewportRef.current?.contains(event.target)) event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") clearSpace();
    };
    const blur = () => {
      clearSpace();
      cancelGestures();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") blur();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cancelGestures]);

  // An unmount can interrupt a drag or a relocation glide; drop both. Exit
  // timers are intentionally left to fire so an awaited host mutation is never
  // lost when the canvas switches mid-exit.
  useEffect(() => () => {
    panRef.current = null;
    selectRef.current = null;
    nodeDragRef.current = null;
    cardDragRef.current = null;
    const connect = connectRef.current;
    connectRef.current = null;
    connect?.cleanup();
    if (flipRafRef.current !== null) cancelAnimationFrame(flipRafRef.current);
    flipRafRef.current = null;
    syncBusy();
  }, [syncBusy]);

  // Viewport resizes: keep the world point under the viewport center stable
  // (imperative offset adjustment), sync React once per resize burst, and flip
  // the minimap breakpoint. No per-frame React state.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const width = entry?.contentRect.width ?? element.clientWidth;
      const height = entry?.contentRect.height ?? element.clientHeight;
      const previous = viewportSizeRef.current;
      viewportSizeRef.current = { width, height };
      if (previous && (previous.width !== width || previous.height !== height) && width > 0 && height > 0) {
        const zoom = zoomRef.current;
        const centerWorldY = (previous.height / 2 - offsetRef.current.y) / zoom;
        const nextX = resizeAnchorXRef.current === "right"
          ? offsetRef.current.x + (width - previous.width)
          : width / 2 - ((previous.width / 2 - offsetRef.current.x) / zoom) * zoom;
        applyWorldTransform({ x: nextX, y: height / 2 - centerWorldY * zoom }, zoom);
        if (viewportSyncTimerRef.current !== undefined) window.clearTimeout(viewportSyncTimerRef.current);
        viewportSyncTimerRef.current = window.setTimeout(() => {
          viewportSyncTimerRef.current = undefined;
          resizeAnchorXRef.current = "center";
          setOffset(offsetRef.current);
          propsRef.current.onViewport({ x: offsetRef.current.x, y: offsetRef.current.y, zoom: zoomRef.current });
        }, 150);
      }
      const nextWide = width >= MINIMAP_MIN_CANVAS;
      setCanvasWide((current) => (current === nextWide ? current : nextWide));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (viewportSyncTimerRef.current !== undefined) window.clearTimeout(viewportSyncTimerRef.current);
    };
  }, [applyWorldTransform]);

  // External reveal request (opening a canvas from a full page): center the
  // requested node with a glide.
  useEffect(() => {
    if (!props.focusRequest) return;
    const node = canvas.nodes.find((item) => item.id === props.focusRequest?.nodeId);
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!node || !rect) return;
    const fitZoom = clampZoom(Math.min(1, (rect.width - 96) / Math.max(1, node.width), (rect.height - 96) / Math.max(1, node.height)));
    const targetZoom = Math.min(zoomRef.current, fitZoom);
    beginGlide({
      x: rect.width / 2 - (node.x + node.width / 2) * targetZoom,
      y: rect.height / 2 - (node.y + node.height / 2) * targetZoom,
    }, targetZoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusRequest]);

  const handToolActive = () => propsRef.current.interactionMode === "pan" || spaceRef.current;
  const panPointer = (event: React.PointerEvent<HTMLElement>) => event.button === 1 || (event.button === 0 && handToolActive());

  // ---- node gestures ---------------------------------------------------------
  const nodePointerDown = (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => {
    if (propsRef.current.busy) return;
    if (panPointer(event) || isEditable(event.target)) return;
    if (event.button !== 0 || nodeDragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    clearFlip();
    settleGlide();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    const activeIds = selectedNodeIdsRef.current;
    if (event.shiftKey) {
      propsRef.current.onSelectNode(node.id, true);
      // A shift-click that removes the node from the selection never starts a drag.
      if (activeIds.includes(node.id)) return;
    } else if (!activeIds.includes(node.id)) {
      propsRef.current.onSelectNode(node.id, false);
    }
    const movingIds = event.shiftKey ? [node.id] : (activeIds.includes(node.id) ? activeIds : [node.id]);
    const byId = new Map(canvasRef.current.nodes.map((item) => [item.id, item]));
    const moving = movingIds
      .map((id) => { const item = byId.get(id); return item ? { id, x: item.x, y: item.y } : null; })
      .filter((item): item is { id: string; x: number; y: number } => item !== null);
    if (moving.length === 0) return;
    for (const item of moving) nodeElements.current.get(item.id)?.classList.add("dragging");
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      collapseOnClick: !event.shiftKey && activeIds.length > 1 && activeIds.includes(node.id),
      moving,
      originX: Math.min(...moving.map((item) => item.x)),
      originY: Math.min(...moving.map((item) => item.y)),
      snapping: false,
      cardId: null,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    edgeLayerRef.current?.beginDrag(moving.map((item) => ({ kind: "node" as const, nodeId: item.id })));
    element.setPointerCapture(event.pointerId);
    syncBusy();
  };

  const cardAt = (clientX: number, clientY: number): string | null => {
    const card = document.elementsFromPoint(clientX, clientY)
      .map((element) => (element instanceof Element ? element.closest<HTMLElement>(".canvas-node-card") : null))
      .find((element): element is HTMLElement => element !== null) ?? null;
    return card?.dataset.canvasId ?? null;
  };

  const updateCardHover = (drag: NodeDragSession) => {
    const nextId = cardAt(drag.clientX, drag.clientY);
    if (nextId === drag.cardId) return;
    if (drag.cardId) cardElements.current.get(drag.cardId)?.classList.remove("card-hover");
    drag.cardId = nextId;
    if (nextId) cardElements.current.get(nextId)?.classList.add("card-hover");
  };

  const nodePointerMove = (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.nodeId !== node.id) return;
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    const raw = {
      x: (event.clientX - drag.startX) / zoomRef.current,
      y: (event.clientY - drag.startY) / zoomRef.current,
    };
    const snapping = isSnapActive(propsRef.current.snapToGrid, event.altKey);
    const delta = snappedDelta({ x: drag.originX, y: drag.originY }, raw, propsRef.current.gridSize, snapping);
    drag.dx = delta.x;
    drag.dy = delta.y;
    if (snapping !== drag.snapping) {
      drag.snapping = snapping;
      for (const item of drag.moving) nodeElements.current.get(item.id)?.classList.toggle("snap-drag", snapping);
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
    if (!drag.moved) return;
    for (const item of drag.moving) {
      const element = nodeElements.current.get(item.id);
      if (element) element.style.translate = `${drag.dx}px ${drag.dy}px`;
    }
    edgeLayerRef.current?.updateDrag(drag.dx, drag.dy);
    updateCardHover(drag);
  };

  const finishNodeDrag = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    const dropCardId = commit && drag.moved ? cardAt(event.clientX, event.clientY) : null;
    if (drag.cardId) cardElements.current.get(drag.cardId)?.classList.remove("card-hover");
    for (const item of drag.moving) nodeElements.current.get(item.id)?.classList.remove("dragging", "snap-drag");
    edgeLayerRef.current?.endDrag();
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    syncBusy();
    const snapping = isSnapActive(propsRef.current.snapToGrid, event.altKey);
    const release = commit
      ? snappedDelta(
        { x: drag.originX, y: drag.originY },
        { x: (event.clientX - drag.startX) / zoomRef.current, y: (event.clientY - drag.startY) / zoomRef.current },
        propsRef.current.gridSize,
        snapping,
      )
      : { x: drag.dx, y: drag.dy };
    const positions = drag.moving.map((item) => ({ id: item.id, x: item.x + release.x, y: item.y + release.y }));
    if (commit && drag.moved && !dropCardId) {
      for (const position of positions) {
        const target = nodeElements.current.get(position.id);
        if (target) {
          target.style.left = `${position.x}px`;
          target.style.top = `${position.y}px`;
        }
      }
    }
    for (const item of drag.moving) {
      const target = nodeElements.current.get(item.id);
      if (target) target.style.translate = "";
    }
    if (!commit) return;
    if (drag.moved) {
      for (const position of positions) displayedRef.current.set(`node:${position.id}`, { x: position.x, y: position.y });
      if (dropCardId) propsRef.current.onNodesDrop(drag.moving.map((item) => item.id), dropCardId);
      else propsRef.current.onNodesMove(positions);
      return;
    }
    if (drag.collapseOnClick) propsRef.current.onSelectNode(drag.nodeId, false);
  };

  // ---- sub-canvas card gestures ---------------------------------------------
  const cardPointerDown = (event: React.PointerEvent<HTMLElement>, canvasId: string) => {
    if (propsRef.current.busy) return;
    if (panPointer(event) || isEditable(event.target)) return;
    if (event.button !== 0 || cardDragRef.current) return;
    const card = state.canvases.find((item) => item.id === canvasId);
    if (!card?.frame) return;
    event.preventDefault();
    event.stopPropagation();
    clearFlip();
    settleGlide();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    element.classList.add("dragging");
    cardDragRef.current = {
      pointerId: event.pointerId,
      canvasId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
      snapping: false,
      frame: card.frame,
    };
    edgeLayerRef.current?.beginDrag([{ kind: "card", canvasId }]);
    element.setPointerCapture(event.pointerId);
    syncBusy();
  };

  const cardPointerMove = (event: React.PointerEvent<HTMLElement>, canvasId: string) => {
    const drag = cardDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.canvasId !== canvasId) return;
    const raw = {
      x: (event.clientX - drag.startX) / zoomRef.current,
      y: (event.clientY - drag.startY) / zoomRef.current,
    };
    const snapping = isSnapActive(propsRef.current.snapToGrid, event.altKey);
    const delta = snappedDelta({ x: drag.frame.x, y: drag.frame.y }, raw, propsRef.current.gridSize, snapping);
    drag.dx = delta.x;
    drag.dy = delta.y;
    const element = cardElements.current.get(canvasId);
    if (snapping !== drag.snapping) {
      drag.snapping = snapping;
      element?.classList.toggle("snap-drag", snapping);
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (element) element.style.translate = `${drag.dx}px ${drag.dy}px`;
    edgeLayerRef.current?.updateDrag(drag.dx, drag.dy);
  };

  const finishCardDrag = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const drag = cardDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cardDragRef.current = null;
    edgeLayerRef.current?.endDrag();
    const element = event.currentTarget;
    element.classList.remove("dragging", "snap-drag");
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    syncBusy();
    if (commit && drag.moved) {
      const snapping = isSnapActive(propsRef.current.snapToGrid, event.altKey);
      const release = snappedDelta(
        { x: drag.frame.x, y: drag.frame.y },
        { x: (event.clientX - drag.startX) / zoomRef.current, y: (event.clientY - drag.startY) / zoomRef.current },
        propsRef.current.gridSize,
        snapping,
      );
      const frame = { ...drag.frame, x: drag.frame.x + release.x, y: drag.frame.y + release.y };
      element.style.left = `${frame.x}px`;
      element.style.top = `${frame.y}px`;
      element.style.translate = "";
      displayedRef.current.set(`card:${drag.canvasId}`, { x: frame.x, y: frame.y });
      propsRef.current.onCardMove(drag.canvasId, frame);
      return;
    }
    element.style.translate = "";
    if (commit) propsRef.current.onSelectCard(drag.canvasId);
  };

  // ---- relation drawing ------------------------------------------------------
  const nodeIdAt = (clientX: number, clientY: number, excludeId: string): string | null => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const nodeElement = element instanceof Element ? element.closest<HTMLElement>("[data-node-id]") : null;
      const id = nodeElement?.dataset.nodeId;
      if (id && id !== excludeId) return id;
    }
    return null;
  };

  const connectStart = (event: React.PointerEvent<HTMLElement>, node: CanvasNode, side: EdgeSide) => {
    if (propsRef.current.busy) return;
    if (panPointer(event) || isEditable(event.target)) return;
    if (event.button !== 0 || connectRef.current || nodeDragRef.current || panRef.current) return;
    const path = connectPathRef.current;
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    clearFlip();
    settleGlide();
    const element = event.currentTarget;
    const start = sidePoint(node, side);
    const pointerId = event.pointerId;
    const session: ConnectSession = { pointerId, fromNodeId: node.id, start, targetId: null, element, cleanup: () => {} };
    const update = (clientX: number, clientY: number) => {
      const point = worldPointFromClient(clientX, clientY);
      if (!point) return;
      path.setAttribute("d", `M ${start.x} ${start.y} L ${point.x} ${point.y}`);
      const targetId = nodeIdAt(clientX, clientY, session.fromNodeId);
      if (targetId === session.targetId) return;
      if (session.targetId) nodeElements.current.get(session.targetId)?.classList.remove("connect-target");
      session.targetId = targetId;
      if (targetId) nodeElements.current.get(targetId)?.classList.add("connect-target");
    };
    const complete = (commit: boolean) => {
      if (connectRef.current !== session) return;
      connectRef.current = null;
      session.cleanup();
      if (session.element.hasPointerCapture(pointerId)) session.element.releasePointerCapture(pointerId);
      if (session.targetId) nodeElements.current.get(session.targetId)?.classList.remove("connect-target");
      path.classList.remove("active");
      path.removeAttribute("d");
      syncBusy();
      if (commit && session.targetId) propsRef.current.onEdgeCreate(session.fromNodeId, session.targetId);
    };
    const move = (native: PointerEvent) => { if (native.pointerId === pointerId) update(native.clientX, native.clientY); };
    const up = (native: PointerEvent) => { if (native.pointerId === pointerId) complete(true); };
    const cancel = () => complete(false);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    element.addEventListener("lostpointercapture", cancel);
    session.cleanup = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
      element.removeEventListener("lostpointercapture", cancel);
    };
    connectRef.current = session;
    path.setAttribute("d", `M ${start.x} ${start.y} L ${start.x} ${start.y}`);
    path.classList.add("active");
    element.setPointerCapture(pointerId);
    syncBusy();
  };

  // ---- viewport gestures -----------------------------------------------------
  // Capture before nodes, card buttons, handles and edge hit areas can consume
  // pointerdown; every canvas item is a valid starting point for the hand tool.
  const viewportPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".mini-map") || isEditable(event.target)) return;
    if (!panPointer(event)) {
      suppressPanClickRef.current = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (panRef.current || selectRef.current || nodeDragRef.current || cardDragRef.current || connectRef.current) return;
    stopGlide();
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
    };
    suppressPanClickRef.current = true;
    if (!capturePointer(viewportRef.current, event.pointerId)) {
      panRef.current = null;
      syncBusy();
      return;
    }
    setPanning(true);
    syncBusy();
  };

  const viewportPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".mini-map") || isEditable(event.target)) return;
    if (event.button !== 0 || propsRef.current.busy || panRef.current || selectRef.current || nodeDragRef.current || cardDragRef.current || connectRef.current) return;
    settleGlide();
    event.preventDefault();
    event.stopPropagation();
    const start = worldPointFromClient(event.clientX, event.clientY);
    if (!start) return;
    selectRef.current = { pointerId: event.pointerId, start, additive: event.shiftKey, rect: null };
    if (!capturePointer(viewportRef.current, event.pointerId)) {
      selectRef.current = null;
      setSelectionRect(null);
      syncBusy();
      return;
    }
    syncBusy();
  };

  const viewportPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      applyWorldTransform({
        x: pan.originX + event.clientX - pan.startX,
        y: pan.originY + event.clientY - pan.startY,
      }, zoomRef.current);
      return;
    }
    const select = selectRef.current;
    if (!select || select.pointerId !== event.pointerId) return;
    const end = worldPointFromClient(event.clientX, event.clientY);
    if (!end) return;
    const rect = normalizeSelectionRect(select.start, end);
    select.rect = rect;
    setSelectionRect(rect);
  };

  const finishViewportGesture = (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      panRef.current = null;
      if (viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
      setPanning(false);
      // Navigation is safe to retain on pointercancel/lost capture as well;
      // publishing it keeps React, the mini-map and persistence in agreement.
      commitViewport(offsetRef.current, zoomRef.current);
      syncBusy();
      return;
    }
    const select = selectRef.current;
    if (!select || select.pointerId !== event.pointerId) return;
    selectRef.current = null;
    setSelectionRect(null);
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
    syncBusy();
    if (!commit) return;
    const rect = select.rect;
    if (rect && (rect.width > 3 || rect.height > 3)) {
      propsRef.current.onSelectNodes(itemsInSelectionRect(nodes, rect), select.additive);
    } else if (!select.additive) {
      propsRef.current.onSelectNodes([], false);
    }
  };

  const minimapNavigate = (nextOffset: { x: number; y: number }, commit: boolean) => {
    stopGlide();
    applyWorldTransform(nextOffset, zoomRef.current);
    syncBusy();
    if (!commit) return;
    setOffset(nextOffset);
    propsRef.current.onViewport({ x: nextOffset.x, y: nextOffset.y, zoom: zoomRef.current });
  };

  const zoomBy = (delta: number) => {
    const currentZoom = glideRef.current?.targetZoom ?? zoomRef.current;
    const nextZoom = Math.round(clampZoom(currentZoom + delta) * 10) / 10;
    if (nextZoom === currentZoom) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    const centerX = rect ? rect.width / 2 : 320;
    const centerY = rect ? rect.height / 2 : 240;
    const base = glideRef.current?.targetOffset ?? offsetRef.current;
    beginGlide({
      x: centerX - ((centerX - base.x) / currentZoom) * nextZoom,
      y: centerY - ((centerY - base.y) / currentZoom) * nextZoom,
    }, nextZoom);
  };

  const locateAll = (): boolean => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const items = canvasRef.current.nodes;
    const frames = propsRef.current.state.canvases.flatMap((item) => (item.parentId === canvasRef.current.id && item.frame ? [item.frame] : []));
    if (!rect || (items.length === 0 && frames.length === 0)) return false;
    const boxes = [
      ...items.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height })),
      ...frames,
    ];
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    const nextZoom = clampZoom(Math.min((rect.width - 72) / Math.max(1, maxX - minX), (rect.height - 72) / Math.max(1, maxY - minY)));
    beginGlide({
      x: rect.width / 2 - ((minX + maxX) / 2) * nextZoom,
      y: rect.height / 2 - ((minY + maxY) / 2) * nextZoom,
    }, Math.round(nextZoom * 100) / 100);
    return true;
  };

  useImperativeHandle(ref, () => ({
    containsClient(clientX, clientY) {
      const rect = viewportRef.current?.getBoundingClientRect();
      return Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
    },
    beginWindowAnchoredResize() {
      resizeAnchorXRef.current = "right";
    },
    worldPoint: (clientX, clientY) => worldPointFromClient(clientX, clientY),
    importViewport() {
      const element = viewportRef.current;
      if (!element) return null;
      const base = glideRef.current?.targetOffset ?? offsetRef.current;
      return {
        x: base.x,
        y: base.y,
        zoom: glideRef.current?.targetZoom ?? zoomRef.current,
        width: element.clientWidth,
        height: element.clientHeight,
      };
    },
    zoomBy,
    locateAll,
    playExit,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // ---- stable child callbacks ------------------------------------------------
  const registerNodeElement = useCallback((nodeId: string, element: HTMLElement | null) => {
    if (element) nodeElements.current.set(nodeId, element);
    else nodeElements.current.delete(nodeId);
  }, []);
  const registerCardElement = useCallback((canvasId: string, element: HTMLElement | null) => {
    if (element) cardElements.current.set(canvasId, element);
    else cardElements.current.delete(canvasId);
  }, []);

  const implRef = useRef<{
    nodePointerDown: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
    nodePointerMove: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
    finishNodeDrag: (event: React.PointerEvent<HTMLElement>, commit: boolean) => void;
    cardPointerDown: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
    cardPointerMove: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
    finishCardDrag: (event: React.PointerEvent<HTMLElement>, commit: boolean) => void;
    connectStart: (event: React.PointerEvent<HTMLElement>, node: CanvasNode, side: EdgeSide) => void;
    openNode: (node: CanvasNode, origin: HTMLElement) => void;
    toggleNode: (nodeId: string) => void;
    nodeActions: (event: React.MouseEvent<HTMLElement> | null, node: CanvasNode) => void;
    openCard: (canvasId: string) => void;
    cardMenu: (event: React.MouseEvent<HTMLElement> | null, canvasId: string) => void;
    edgeSelect: (edgeId: string, toggle: boolean) => void;
    edgeMenu: (edgeId: string, clientX: number, clientY: number) => void;
  } | null>(null);
  implRef.current = {
    nodePointerDown, nodePointerMove, finishNodeDrag,
    cardPointerDown, cardPointerMove, finishCardDrag,
    connectStart,
    openNode: (node: CanvasNode, origin: HTMLElement) => { if (!handToolActive()) propsRef.current.onOpenContent(node.contentId, origin); },
    toggleNode: (nodeId: string) => { if (!handToolActive()) propsRef.current.onSelectNode(nodeId, true); },
    nodeActions: (event: React.MouseEvent<HTMLElement> | null, node: CanvasNode) => propsRef.current.onNodeActions(event, node.id),
    openCard: (canvasId: string) => { if (!handToolActive()) propsRef.current.onOpenCanvas(canvasId); },
    cardMenu: (event: React.MouseEvent<HTMLElement> | null, canvasId: string) => propsRef.current.onCardMenu(event, canvasId),
    edgeSelect: (edgeId: string, toggle: boolean) => { if (!handToolActive()) propsRef.current.onSelectEdge(edgeId, toggle); },
    edgeMenu: (edgeId: string, clientX: number, clientY: number) => propsRef.current.onEdgeMenu(edgeId, clientX, clientY),
  };

  const handleNodePointerDown = useCallback((event: React.PointerEvent<HTMLElement>, node: CanvasNode) => implRef.current?.nodePointerDown(event, node), []);
  const handleNodePointerMove = useCallback((event: React.PointerEvent<HTMLElement>, node: CanvasNode) => implRef.current?.nodePointerMove(event, node), []);
  const handleNodePointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => implRef.current?.finishNodeDrag(event, true), []);
  const handleNodePointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => implRef.current?.finishNodeDrag(event, false), []);
  const handleConnectStart = useCallback((event: React.PointerEvent<HTMLElement>, node: CanvasNode, side: EdgeSide) => implRef.current?.connectStart(event, node, side), []);
  const handleOpenNode = useCallback((node: CanvasNode, origin: HTMLElement) => implRef.current?.openNode(node, origin), []);
  const handleToggleNode = useCallback((nodeId: string) => implRef.current?.toggleNode(nodeId), []);
  const handleNodeActions = useCallback((event: React.MouseEvent<HTMLElement> | null, node: CanvasNode) => implRef.current?.nodeActions(event, node), []);

  const handleCardPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, canvasId: string) => implRef.current?.cardPointerDown(event, canvasId), []);
  const handleCardPointerMove = useCallback((event: React.PointerEvent<HTMLElement>, canvasId: string) => implRef.current?.cardPointerMove(event, canvasId), []);
  const handleCardPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => implRef.current?.finishCardDrag(event, true), []);
  const handleCardPointerCancel = useCallback((event: React.PointerEvent<HTMLElement>) => implRef.current?.finishCardDrag(event, false), []);
  const handleOpenCard = useCallback((canvasId: string) => implRef.current?.openCard(canvasId), []);
  const handleCardMenu = useCallback((event: React.MouseEvent<HTMLElement> | null, canvasId: string) => implRef.current?.cardMenu(event, canvasId), []);
  const handleEdgeSelect = useCallback((edgeId: string, toggle: boolean) => implRef.current?.edgeSelect(edgeId, toggle), []);
  const handleEdgeMenu = useCallback((edgeId: string, clientX: number, clientY: number) => implRef.current?.edgeMenu(edgeId, clientX, clientY), []);

  const empty = nodes.length === 0 && cards.length === 0;
  const handTool = interactionMode === "pan" || spacePressed;
  const suppressPanActivation = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".mini-map") || isEditable(event.target)) return;
    if (!handToolActive() && !suppressPanClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport pattern-${props.appearance.pattern}${props.enterMotion === "into" ? " canvas-enter-into" : props.enterMotion === "out" ? " canvas-enter-out" : ""}${handTool ? " hand-tool" : ""}${panning ? " is-panning" : ""}`}
      style={{
        "--canvas-bg": props.appearance.backgroundCustomized ? props.appearance.background : "var(--surface-canvas)",
        "--canvas-pattern": props.appearance.inkCustomized ? patternInk(props.appearance) : "var(--canvas-pattern-default)",
        cursor: panning ? "grabbing" : handTool ? "grab" : undefined,
      } as CSSProperties}
      role="region"
      aria-label={`画布：${canvas.name}`}
      onPointerDownCapture={viewportPointerDownCapture}
      onPointerDown={viewportPointerDown}
      onClickCapture={suppressPanActivation}
      onDoubleClickCapture={suppressPanActivation}
      onPointerMove={viewportPointerMove}
      onPointerUp={(event) => finishViewportGesture(event, true)}
      onPointerCancel={(event) => finishViewportGesture(event, false)}
      onLostPointerCapture={(event) => finishViewportGesture(event, false)}
      onContextMenu={(event) => {
        event.preventDefault();
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".mini-map")) return;
        if (propsRef.current.busy || panRef.current || selectRef.current || nodeDragRef.current || cardDragRef.current || connectRef.current) return;
        propsRef.current.onCanvasContextMenu(event.clientX, event.clientY);
      }}
    >
      <div ref={worldRef} className="canvas-world">
        <EdgeLayer
          ref={edgeLayerRef}
          edges={edges}
          selectedIds={props.selectedEdgeIds}
          onSelect={handleEdgeSelect}
          onContextMenu={handleEdgeMenu}
        />
        {nodes.map((node) => {
          const content = contents[node.contentId];
          return (
            <CanvasNodeView
              key={node.id}
              node={node}
              content={content}
              selected={selectedNodeSet.has(node.id)}
              onElement={registerNodeElement}
              onPointerDown={handleNodePointerDown}
              onPointerMove={handleNodePointerMove}
              onPointerUp={handleNodePointerUp}
              onPointerCancel={handleNodePointerCancel}
              onConnectStart={handleConnectStart}
              onOpen={handleOpenNode}
              onToggleSelect={handleToggleNode}
              onQuickActions={handleNodeActions}
            />
          );
        })}
        {cards.map((card) => (
          <CanvasNodeCard
            key={card.id}
            canvas={card}
            selected={props.selectedCardId === card.id}
            onElement={registerCardElement}
            onPointerDown={handleCardPointerDown}
            onPointerMove={handleCardPointerMove}
            onPointerUp={handleCardPointerUp}
            onPointerCancel={handleCardPointerCancel}
            onOpen={handleOpenCard}
            onMenu={handleCardMenu}
          />
        ))}
        <svg className="connect-layer" aria-hidden="true">
          <path ref={connectPathRef} className="connect-path" />
        </svg>
      </div>
      {selectionRect && (
        <div
          className="selection-rect"
          style={{
            left: `${selectionRect.x * zoom + offset.x}px`,
            top: `${selectionRect.y * zoom + offset.y}px`,
            width: `${selectionRect.width * zoom}px`,
            height: `${selectionRect.height * zoom}px`,
          }}
        />
      )}
      {empty && (
        <div className="empty-canvas">
          <div className="empty-icon">↘</div>
          <strong>把内容拖到悬浮窗</strong>
          <span>复制的文字、链接和图片会进入剪贴板历史；也可以在本页按 Ctrl+V 粘贴</span>
        </div>
      )}
      <MiniMap
        open={!empty && canvasWide}
        narrow={!canvasWide}
        nodes={nodes}
        cards={cards}
        viewportRef={viewportRef}
        offset={offset}
        zoom={zoom}
        onNavigate={minimapNavigate}
      />
    </div>
  );
});
