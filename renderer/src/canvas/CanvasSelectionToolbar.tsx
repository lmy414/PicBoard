import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { PresenceState } from "../ui/motion";

const CANVAS_INSET = 8;
const ANCHOR_GAP = 10;
const CONTROLS_GAP = 6;
const CONTROLS = ".canvas-dock, .canvas-view-dock, .mini-map, .history-slot.open.overlay .hist-drawer";

export function CanvasSelectionToolbar({ nodeIds, edgeIds, open, motion, children }: {
  nodeIds: readonly string[];
  edgeIds: readonly string[];
  open: boolean;
  motion: PresenceState["phase"];
  children: ReactNode;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const workspace = toolbar?.parentElement;
    const layout = workspace?.parentElement;
    const viewport = workspace?.querySelector<HTMLElement>(".canvas-viewport");
    const world = viewport?.querySelector(".canvas-world");
    if (!open || !toolbar || !workspace || !layout || !viewport || !world) return;

    const historySlot = layout.querySelector(".history-slot");
    const anchors = Array.from(world.querySelectorAll(nodeIds.length ? ".canvas-node.selected" : ".edge.selected"));
    const place = () => {
      const canvas = viewport.getBoundingClientRect();
      const { width, height } = toolbar.getBoundingClientRect();
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const anchor of anchors) {
        if (!anchor.isConnected) continue;
        const rect = anchor.getBoundingClientRect();
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (!width || !height || right < canvas.left || left > canvas.right || bottom < canvas.top || top > canvas.bottom) {
        toolbar.removeAttribute("data-positioned");
        return;
      }

      const minLeft = canvas.left + CANVAS_INSET;
      const maxLeft = canvas.right - CANVAS_INSET - width;
      const idealLeft = Math.max(minLeft, Math.min((left + right - width) / 2, maxLeft));
      const controls = Array.from(layout.querySelectorAll(CONTROLS))
        .filter((element) => !element.closest('[data-motion="exit"]'))
        .map((element) => element.getBoundingClientRect());
      const positionAt = (row: number) => {
        if (row < canvas.top + CANVAS_INSET || row + height > canvas.bottom - CANVAS_INSET) return null;
        const blockers = controls.filter((rect) => row + height > rect.top - CONTROLS_GAP && row < rect.bottom + CONTROLS_GAP);
        const candidates = [idealLeft, ...blockers.flatMap((rect) => [rect.left - width - CONTROLS_GAP, rect.right + CONTROLS_GAP])];
        const clearLeft = candidates
          .filter((candidate) => candidate >= minLeft && candidate <= maxLeft && candidate <= right && candidate + width >= left)
          .filter((candidate) => blockers.every((rect) => candidate + width <= rect.left - CONTROLS_GAP || candidate >= rect.right + CONTROLS_GAP))
          .sort((first, second) => Math.abs(first - idealLeft) - Math.abs(second - idealLeft))[0];
        return clearLeft === undefined ? null : { left: clearLeft, top: row };
      };
      const position = positionAt(bottom + ANCHOR_GAP) ?? positionAt(top - ANCHOR_GAP - height);
      toolbar.toggleAttribute("data-positioned", position !== null);
      if (!position) return;

      const origin = workspace.getBoundingClientRect();
      toolbar.style.translate = `${position.left - origin.left}px ${position.top - origin.top}px`;
    };

    const resize = new ResizeObserver(place);
    resize.observe(viewport);
    resize.observe(toolbar);
    const changes = new MutationObserver(place);
    changes.observe(world, { attributes: true, attributeFilter: ["style"] });
    for (const anchor of anchors) {
      changes.observe(anchor, { subtree: anchor instanceof SVGElement, attributes: true, attributeFilter: ["style", "d"] });
    }
    changes.observe(workspace, { subtree: true, childList: true });
    if (historySlot) changes.observe(historySlot, { attributes: true, attributeFilter: ["class"] });
    layout.addEventListener("transitionend", place);
    layout.addEventListener("animationend", place);
    place();

    return () => {
      changes.disconnect();
      resize.disconnect();
      layout.removeEventListener("transitionend", place);
      layout.removeEventListener("animationend", place);
    };
  }, [open, nodeIds, edgeIds]);

  return (
    <div ref={toolbarRef} className="selection-toolbar motion-fade" role="group" aria-label="选区操作" data-motion={motion}>
      {children}
    </div>
  );
}
