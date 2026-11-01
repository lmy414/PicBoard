import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { edgePath, type EdgePath, type Rect, type ResolvedEdge } from "../../../shared/edge-geometry";

/** A node or sub-canvas card being dragged; edges touching it follow live. */
export type EdgeDragTarget = { kind: "node"; nodeId: string } | { kind: "card"; canvasId: string };

export interface EdgeLayerHandle {
  beginDrag(targets: EdgeDragTarget[]): void;
  updateDrag(dx: number, dy: number): void;
  endDrag(): void;
  /** Per-end world offsets while nodes/cards glide to a relocated position. */
  applyOffsets(offsets: Map<string, { dx: number; dy: number }>): void;
  clearOffsets(): void;
  /** Fade out edges that are about to be removed. */
  markExiting(edgeIds: string[]): void;
  clearExiting(): void;
}

interface DragEntry {
  from: Rect;
  to: Rect;
  fromMoves: boolean;
  toMoves: boolean;
  line: SVGPathElement;
  arrow: SVGPathElement;
  originalPath: string;
  originalArrow: string;
}

interface OffsetEntry {
  from: Rect;
  to: Rect;
  fromKey: string;
  toKey: string;
  line: SVGPathElement;
  arrow: SVGPathElement;
  originalPath: string;
  originalArrow: string;
}

const NO_OFFSET = { dx: 0, dy: 0 };

const endKey = (end: EdgeDragTarget): string => `${end.kind}:${end.kind === "node" ? end.nodeId : end.canvasId}`;

/** Arrowhead transform: pin the mark to the target side and point along the curve. */
function arrowTransform(path: EdgePath): string {
  return `translate(${path.end.x} ${path.end.y}) rotate(${Math.round((path.endAngle * 180) / Math.PI)})`;
}

/**
 * Relation edges, drawn under cards and nodes. Paths are declarative except
 * while a node/card drag is active: then the affected paths are written
 * straight to the DOM and restored on release.
 */
export const EdgeLayer = forwardRef<EdgeLayerHandle, {
  edges: ResolvedEdge[];
  selectedIds: string[];
  onSelect: (edgeId: string, toggle: boolean) => void;
  onContextMenu: (edgeId: string, clientX: number, clientY: number) => void;
}>(function EdgeLayer({ edges, selectedIds, onSelect, onContextMenu }, ref) {
  const groups = useRef(new Map<string, SVGGElement>());
  const dragRef = useRef<DragEntry[] | null>(null);
  const offsetRef = useRef<OffsetEntry[] | null>(null);
  const paths = useMemo(() => edges.map((edge) => ({ edge, path: edgePath(edge.from.rect, edge.to.rect) })), [edges]);

  useImperativeHandle(ref, () => ({
    beginDrag(targets) {
      const keys = new Set(targets.map(endKey));
      const entries: DragEntry[] = [];
      for (const { edge, path } of paths) {
        const fromMoves = keys.has(endKey(edge.from));
        const toMoves = keys.has(endKey(edge.to));
        if (!fromMoves && !toMoves) continue;
        const group = groups.current.get(edge.edgeId);
        const line = group?.querySelector<SVGPathElement>(".edge-line");
        const arrow = group?.querySelector<SVGPathElement>(".edge-arrow");
        if (!line || !arrow) continue;
        entries.push({
          from: edge.from.rect,
          to: edge.to.rect,
          fromMoves,
          toMoves,
          line,
          arrow,
          originalPath: line.getAttribute("d") ?? path.d,
          originalArrow: arrow.getAttribute("transform") ?? arrowTransform(path),
        });
      }
      dragRef.current = entries;
    },
    updateDrag(dx, dy) {
      const entries = dragRef.current;
      if (!entries) return;
      for (const entry of entries) {
        const from = entry.fromMoves ? { ...entry.from, x: entry.from.x + dx, y: entry.from.y + dy } : entry.from;
        const to = entry.toMoves ? { ...entry.to, x: entry.to.x + dx, y: entry.to.y + dy } : entry.to;
        const path = edgePath(from, to);
        entry.line.setAttribute("d", path.d);
        entry.arrow.setAttribute("transform", arrowTransform(path));
      }
    },
    endDrag() {
      const entries = dragRef.current;
      if (!entries) return;
      for (const entry of entries) {
        entry.line.setAttribute("d", entry.originalPath);
        entry.arrow.setAttribute("transform", entry.originalArrow);
      }
      dragRef.current = null;
    },
    applyOffsets(offsets) {
      let entries = offsetRef.current;
      if (!entries) {
        entries = [];
        for (const { edge, path } of paths) {
          const fromKey = endKey(edge.from);
          const toKey = endKey(edge.to);
          if (!offsets.has(fromKey) && !offsets.has(toKey)) continue;
          const group = groups.current.get(edge.edgeId);
          const line = group?.querySelector<SVGPathElement>(".edge-line");
          const arrow = group?.querySelector<SVGPathElement>(".edge-arrow");
          if (!line || !arrow) continue;
          entries.push({
            from: edge.from.rect,
            to: edge.to.rect,
            fromKey,
            toKey,
            line,
            arrow,
            originalPath: line.getAttribute("d") ?? path.d,
            originalArrow: arrow.getAttribute("transform") ?? arrowTransform(path),
          });
        }
        offsetRef.current = entries;
      }
      for (const entry of entries) {
        const fromOffset = offsets.get(entry.fromKey) ?? NO_OFFSET;
        const toOffset = offsets.get(entry.toKey) ?? NO_OFFSET;
        const from = { ...entry.from, x: entry.from.x + fromOffset.dx, y: entry.from.y + fromOffset.dy };
        const to = { ...entry.to, x: entry.to.x + toOffset.dx, y: entry.to.y + toOffset.dy };
        const path = edgePath(from, to);
        entry.line.setAttribute("d", path.d);
        entry.arrow.setAttribute("transform", arrowTransform(path));
      }
    },
    clearOffsets() {
      const entries = offsetRef.current;
      if (!entries) return;
      for (const entry of entries) {
        entry.line.setAttribute("d", entry.originalPath);
        entry.arrow.setAttribute("transform", entry.originalArrow);
      }
      offsetRef.current = null;
    },
    markExiting(edgeIds) {
      for (const edgeId of edgeIds) groups.current.get(edgeId)?.setAttribute("data-exit-edge", "true");
    },
    clearExiting() {
      for (const group of groups.current.values()) group.removeAttribute("data-exit-edge");
    },
  }), [paths]);

  return (
    <svg className="edge-layer" aria-hidden="true">
      {paths.map(({ edge, path }) => (
        <g
          key={edge.edgeId}
          className={`edge${selectedIds.includes(edge.edgeId) ? " selected" : ""}`}
          data-edge-id={edge.edgeId}
          ref={(element) => {
            if (element) groups.current.set(edge.edgeId, element);
            else groups.current.delete(edge.edgeId);
          }}
        >
          <path className="edge-line" d={path.d} pathLength={1} />
          <path
            className="edge-arrow"
            d="M -7 -4.5 L 0 0 L -7 4.5"
            transform={arrowTransform(path)}
          />
          <path
            className="edge-hit"
            d={path.d}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.stopPropagation(); onSelect(edge.edgeId, event.shiftKey); }}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(edge.edgeId, event.clientX, event.clientY);
            }}
          />
        </g>
      ))}
    </svg>
  );
});
