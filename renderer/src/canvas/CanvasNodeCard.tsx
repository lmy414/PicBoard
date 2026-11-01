import { memo } from "react";
import type { CanvasRecord } from "../../../shared/image-board";

export interface CanvasNodeCardProps {
  canvas: CanvasRecord;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>, canvasId: string) => void;
  onOpen: (canvasId: string) => void;
  onMenu: (event: React.MouseEvent<HTMLElement> | null, canvasId: string) => void;
  onElement: (canvasId: string, element: HTMLElement | null) => void;
}

/** Collapsed node-group card: a child canvas placed on its parent's world. */
export const CanvasNodeCard = memo(function CanvasNodeCard(props: CanvasNodeCardProps) {
  const { canvas, selected, onElement } = props;
  const frame = canvas.frame;
  if (!frame) return null;
  const count = canvas.nodes.length;

  return (
    <div
      ref={(element) => onElement(canvas.id, element)}
      role="button"
      tabIndex={0}
      data-canvas-id={canvas.id}
      aria-label={`子画布 ${canvas.name}，${count} 个节点`}
      className={`canvas-node-card${selected ? " selected" : ""}`}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      onPointerDown={(event) => props.onPointerDown(event, canvas.id)}
      onPointerMove={(event) => props.onPointerMove(event, canvas.id)}
      onPointerUp={(event) => props.onPointerUp(event, canvas.id)}
      onPointerCancel={(event) => props.onPointerCancel(event, canvas.id)}
      onLostPointerCapture={(event) => props.onPointerCancel(event, canvas.id)}
      onDoubleClick={(event) => { event.stopPropagation(); props.onOpen(canvas.id); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); props.onMenu(event, canvas.id); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); props.onOpen(canvas.id); }
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); props.onMenu(null, canvas.id); }
      }}
    >
      <div className="canvas-node-header">
        <strong>{canvas.name}</strong>
        <span className="canvas-node-badge" title={`${count} 个节点`}>{count}</span>
      </div>
      <div className="canvas-node-body"><span>{count} 个节点 · 双击进入</span></div>
    </div>
  );
});
