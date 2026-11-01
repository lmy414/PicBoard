import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode, CanvasRecord } from "../../../shared/image-board";
import { createMiniMapGeometry, miniMapToWorld, type MiniMapImage } from "../../../shared/minimap-geometry";
import { usePresence } from "../ui/motion";

const WIDTH = 164;
const HEIGHT = 104;

/** Node-based mini-map: navigates the infinite canvas without touching React during the drag. */
export function MiniMap({ open, narrow, nodes, cards, viewportRef, offset, zoom, onNavigate }: {
  open: boolean;
  /** Breakpoint from the stage's viewport observer; also re-frames the geometry. */
  narrow: boolean;
  nodes: CanvasNode[];
  cards: CanvasRecord[];
  viewportRef: React.RefObject<HTMLDivElement | null>;
  offset: { x: number; y: number };
  zoom: number;
  onNavigate: (offset: { x: number; y: number }, commit: boolean) => void;
}) {
  const presence = usePresence(open, 140);
  const mapRef = useRef<HTMLDivElement>(null);
  const viewportRectRef = useRef<SVGRectElement>(null);
  const [dragging, setDragging] = useState(false);

  const items = useMemo<MiniMapImage[]>(() => {
    const list: MiniMapImage[] = nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height }));
    for (const card of cards) {
      if (card.frame) list.push({ id: `card-${card.id}`, x: card.frame.x, y: card.frame.y, width: card.frame.width, height: card.frame.height });
    }
    return list;
  }, [nodes, cards]);

  const geometry = useMemo(() => {
    return createMiniMapGeometry(items, {
      x: offset.x,
      y: offset.y,
      width: viewportRef.current?.clientWidth || 640,
      height: viewportRef.current?.clientHeight || 480,
      zoom,
    }, WIDTH, HEIGHT);
    // `narrow` re-frames the geometry after a resize crosses the breakpoint.
  }, [items, offset.x, offset.y, narrow, viewportRef, zoom]);

  // Re-sync the marker with React's geometry after any committed render; the
  // live drag writes it imperatively between renders.
  useLayoutEffect(() => {
    const marker = viewportRectRef.current;
    if (!marker) return;
    marker.setAttribute("x", String(geometry.viewport.x));
    marker.setAttribute("y", String(geometry.viewport.y));
    marker.setAttribute("width", String(geometry.viewport.width));
    marker.setAttribute("height", String(geometry.viewport.height));
  }, [geometry]);

  const navigate = (event: React.PointerEvent, commit: boolean) => {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const point = miniMapToWorld(geometry, localX, localY);
    const element = viewportRef.current;
    const viewWidth = element?.clientWidth ?? 640;
    const viewHeight = element?.clientHeight ?? 480;
    onNavigate({ x: viewWidth / 2 - point.x * zoom, y: viewHeight / 2 - point.y * zoom }, commit);
    // Keep the viewport marker under the pointer during the drag instead of
    // waiting for the committed offset to re-render the map.
    const marker = viewportRectRef.current;
    if (marker) {
      const width = geometry.viewport.width;
      const height = geometry.viewport.height;
      marker.setAttribute("x", String(Math.min(WIDTH - width, Math.max(0, localX - width / 2))));
      marker.setAttribute("y", String(Math.min(HEIGHT - height, Math.max(0, localY - height / 2))));
    }
  };

  if (!presence.mounted) return null;
  return (
    <div
      ref={mapRef}
      className={`mini-map motion-pop${dragging ? " dragging" : ""}`}
      data-motion={presence.phase}
      aria-label="画布小地图"
      onPointerDown={(event) => {
        event.stopPropagation();
        setDragging(true);
        mapRef.current?.setPointerCapture(event.pointerId);
        navigate(event, false);
      }}
      onPointerMove={(event) => { if (dragging) navigate(event, false); }}
      onPointerUp={(event) => {
        setDragging(false);
        if (mapRef.current?.hasPointerCapture(event.pointerId)) mapRef.current.releasePointerCapture(event.pointerId);
        navigate(event, true);
      }}
      onPointerCancel={() => setDragging(false)}
      onClick={(event) => event.stopPropagation()}
    >
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-hidden="true">
        <rect className="mini-map-bg" x="0" y="0" width={WIDTH} height={HEIGHT} rx="10" />
        {geometry.images.map((item) => <rect key={item.id} className="mini-map-image" x={item.x} y={item.y} width={item.width} height={item.height} rx="2" />)}
        <rect ref={viewportRectRef} className="mini-map-viewport" x={geometry.viewport.x} y={geometry.viewport.y} width={geometry.viewport.width} height={geometry.viewport.height} rx="3" />
      </svg>
    </div>
  );
}
