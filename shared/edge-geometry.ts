import type { AppState, CanvasNode } from "./image-board";

/**
 * Edge projection geometry for the canvas (pure, neutral module).
 *
 * Edges are global records between node ids. A canvas draws an edge only when
 * both ends resolve on it:
 * - a node placed directly on that canvas resolves to its own rect;
 * - a node nested inside a sub-canvas resolves to the card of the direct child
 *   canvas that contains it;
 * - an end that lives outside that canvas subtree is not drawn.
 * Both ends resolving to the same card hides the edge (the relation is
 * internal to that sub-canvas).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EdgeEnd =
  | { kind: "node"; nodeId: string; rect: Rect }
  | { kind: "card"; canvasId: string; rect: Rect };

export interface ResolvedEdge {
  edgeId: string;
  from: EdgeEnd;
  to: EdgeEnd;
}

export interface EdgePath {
  /** SVG path data for the cubic relation curve. */
  d: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Incoming direction at `end`, in radians (arrowhead rotation). */
  endAngle: number;
}

/** Project every edge of the app onto one canvas (see module docs for the rule). */
export function resolveCanvasEdges(state: AppState, canvasId: string): ResolvedEdge[] {
  if (!state.canvases.some((canvas) => canvas.id === canvasId)) return [];

  const canvasById = new Map(state.canvases.map((canvas) => [canvas.id, canvas] as const));
  const nodeCanvasId = new Map<string, string>();
  const nodeById = new Map<string, CanvasNode>();
  for (const canvas of state.canvases) {
    for (const node of canvas.nodes) {
      nodeCanvasId.set(node.id, canvas.id);
      nodeById.set(node.id, node);
    }
  }

  const resolveNode = (nodeId: string): EdgeEnd | null => {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    let canvas = canvasById.get(nodeCanvasId.get(nodeId) ?? "");
    while (canvas) {
      if (canvas.id === canvasId) return { kind: "node", nodeId: node.id, rect: { x: node.x, y: node.y, width: node.width, height: node.height } };
      if (canvas.parentId === canvasId && canvas.frame) {
        return { kind: "card", canvasId: canvas.id, rect: { ...canvas.frame } };
      }
      canvas = canvas.parentId ? canvasById.get(canvas.parentId) : undefined;
    }
    return null;
  };

  const resolved: ResolvedEdge[] = [];
  for (const edge of state.edges) {
    const from = resolveNode(edge.fromNode);
    const to = resolveNode(edge.toNode);
    if (!from || !to) continue;
    if (from.kind === "card" && to.kind === "card" && from.canvasId === to.canvasId) continue;
    resolved.push({ edgeId: edge.id, from, to });
  }
  return resolved;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Route an edge between two rectangles: facing side midpoints chosen by the
 * dominant axis of the center delta, cubic bezier bowed out along that axis.
 */
export function edgePath(fromRect: Rect, toRect: Rect): EdgePath {
  const fromCenter = { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 };
  const toCenter = { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const forward = horizontal ? dx >= 0 : dy >= 0;

  const start = horizontal
    ? { x: forward ? fromRect.x + fromRect.width : fromRect.x, y: fromCenter.y }
    : { x: fromCenter.x, y: forward ? fromRect.y + fromRect.height : fromRect.y };
  const end = horizontal
    ? { x: forward ? toRect.x : toRect.x + toRect.width, y: toCenter.y }
    : { x: toCenter.x, y: forward ? toRect.y : toRect.y + toRect.height };

  const distance = Math.hypot(dx, dy);
  const offset = Math.min(160, Math.max(40, distance * 0.4));
  const direction = forward ? 1 : -1;
  const control1 = horizontal
    ? { x: start.x + direction * offset, y: start.y }
    : { x: start.x, y: start.y + direction * offset };
  const control2 = horizontal
    ? { x: end.x - direction * offset, y: end.y }
    : { x: end.x, y: end.y - direction * offset };

  return {
    d: `M ${round(start.x)} ${round(start.y)} C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(end.x)} ${round(end.y)}`,
    start,
    end,
    endAngle: Math.atan2(end.y - control2.y, end.x - control2.x),
  };
}
