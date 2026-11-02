import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CanvasRecord } from "../../../shared/image-board";
import { IconPage, IconPlus } from "./Icons";
import { usePresence } from "./motion";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Keeps a collapsing branch mounted for its 120 ms exit. */
function TreeBranch({ open, children }: { open: boolean; children: ReactNode }) {
  const presence = usePresence(open, 120);
  if (!presence.mounted) return null;
  return <div className="tree-children motion-slide-down" data-motion={presence.phase}>{children}</div>;
}

/**
 * Small fixed-position action menu shared by tree nodes, canvas cards and
 * edges. Pass `null` to close: the last menu stays mounted for its exit.
 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
  const presence = usePresence(menu !== null, 140);
  const lastRef = useRef<ContextMenuState | null>(menu);
  if (menu) lastRef.current = menu;
  const shown = menu ?? lastRef.current;
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = useState({ left: menu?.x ?? 0, top: menu?.y ?? 0 });
  const x = menu?.x;
  const y = menu?.y;
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || x === undefined || y === undefined) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8)),
    });
  }, [x, y, presence.mounted]);
  const open = menu !== null;
  useLayoutEffect(() => {
    if (!open || !presence.mounted) return;
    itemRefs.current[0]?.focus({ preventScroll: true });
  }, [open, presence.mounted]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      if (items.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        const current = items.findIndex((item) => item === document.activeElement);
        let next: number;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
        else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next].focus({ preventScroll: true });
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.repeat) return;
      const active = document.activeElement;
      const button = active instanceof HTMLElement ? active.closest<HTMLButtonElement>('[role="menuitem"]') : null;
      if (!button || !menuRef.current?.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      button.click();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [onClose, open]);
  if (!presence.mounted || !shown) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="canvas-context-menu motion-pop"
      data-motion={presence.phase}
      data-esc-layer
      role="menu"
      style={pos}
      onContextMenu={(event) => event.preventDefault()}
    >
      {shown.items.map((item, index) => (
        <button
          key={item.label}
          ref={(element) => { itemRefs.current[index] = element; }}
          role="menuitem"
          className={item.danger ? "danger-link" : undefined}
          onClick={() => { onClose(); item.onSelect(); }}
        >{item.label}</button>
      ))}
    </div>,
    document.body,
  );
}

type TreeDropMode = "before" | "after" | "inside";
type TreeDropTarget = { id: string | null; mode: TreeDropMode };

export function CanvasTree({ canvases, activeCanvasId, query, onEnter, onCreateRoot, onCreateChild, onRename, onDelete, onUngroup, onMove }: {
  canvases: CanvasRecord[];
  activeCanvasId: string;
  /** Sidebar search text; empty shows the full tree. */
  query: string;
  onEnter: (canvasId: string) => void;
  onCreateRoot: () => void;
  onCreateChild: (parentId: string) => void;
  onRename: (canvasId: string) => void;
  onDelete: (canvasId: string) => void;
  onUngroup: (canvasId: string) => void;
  onMove: (canvasId: string, parentId: string | null, index: number | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ canvasId: string; x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<TreeDropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const childrenOf = useCallback((parentId: string | null) => canvases.filter((canvas) => (canvas.parentId ?? null) === parentId), [canvases]);

  // Search visibility: a node shows when its name matches or any descendant
  // matches, so the ancestor chain stays reachable while filtering.
  const normalizedQuery = query.trim().toLowerCase();
  const visibleIds = useMemo(() => {
    const visible = new Set<string>();
    if (normalizedQuery === "") return visible;
    const childrenMap = new Map<string | null, CanvasRecord[]>();
    for (const canvas of canvases) {
      const key = canvas.parentId ?? null;
      const bucket = childrenMap.get(key);
      if (bucket) bucket.push(canvas); else childrenMap.set(key, [canvas]);
    }
    const walk = (parentId: string | null): boolean => {
      let anyVisible = false;
      for (const child of childrenMap.get(parentId) ?? []) {
        const childVisible = walk(child.id) || child.name.toLowerCase().includes(normalizedQuery);
        if (childVisible) visible.add(child.id);
        anyVisible = anyVisible || childVisible;
      }
      return anyVisible;
    };
    walk(null);
    return visible;
  }, [canvases, normalizedQuery]);
  const filterActive = normalizedQuery !== "";

  // Keep the active canvas visible: expand its ancestors whenever it changes.
  useEffect(() => {
    const byId = new Map(canvases.map((canvas) => [canvas.id, canvas] as const));
    setExpanded((prev) => {
      let next: Set<string> | null = null;
      let current = byId.get(activeCanvasId);
      while (current?.parentId) {
        if (!prev.has(current.parentId)) {
          next ??= new Set(prev);
          next.add(current.parentId);
        }
        current = byId.get(current.parentId);
      }
      return next ?? prev;
    });
  }, [activeCanvasId, canvases]);

  const isOwnDescendant = useCallback((canvasId: string, maybeParentId: string | null) => {
    if (!maybeParentId) return false;
    const byId = new Map(canvases.map((canvas) => [canvas.id, canvas] as const));
    let current = byId.get(maybeParentId);
    while (current) {
      if (current.id === canvasId) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  }, [canvases]);

  const toggle = (canvasId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(canvasId)) next.delete(canvasId); else next.add(canvasId);
      return next;
    });
  };

  const dragOverNode = (event: React.DragEvent<HTMLDivElement>, canvas: CanvasRecord) => {
    const dragId = dragIdRef.current;
    if (!dragId || dragId === canvas.id || isOwnDescendant(canvas.id, dragId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    const mode: TreeDropMode = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
    setDrop({ id: canvas.id, mode });
  };

  const commitDrop = (event: React.DragEvent, canvas: CanvasRecord | null) => {
    event.preventDefault();
    const dragId = dragIdRef.current;
    const target = drop;
    dragIdRef.current = null;
    setDraggingId(null);
    setDrop(null);
    if (!dragId || !target || dragId === target.id) return;
    if (canvas === null) {
      onMove(dragId, null, null);
      return;
    }
    if (target.mode === "inside") {
      onMove(dragId, canvas.id, null);
      return;
    }
    const siblings = childrenOf(canvas.parentId ?? null);
    onMove(dragId, canvas.parentId ?? null, siblings.indexOf(canvas) + (target.mode === "after" ? 1 : 0));
  };

  const nodeMenu = (canvas: CanvasRecord): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "进入", onSelect: () => onEnter(canvas.id) },
      { label: "新建子画布", onSelect: () => onCreateChild(canvas.id) },
      { label: "重命名", onSelect: () => onRename(canvas.id) },
    ];
    if (canvas.parentId) items.push({ label: "解组", onSelect: () => onUngroup(canvas.id) });
    items.push({ label: "删除", danger: true, onSelect: () => onDelete(canvas.id) });
    return items;
  };

  const renderNodes = (parentId: string | null, depth: number): ReactNode[] =>
    childrenOf(parentId)
      .filter((canvas) => !filterActive || visibleIds.has(canvas.id))
      .map((canvas) => {
      const children = childrenOf(canvas.id);
      const isOpen = filterActive || expanded.has(canvas.id);
      const dropClass = drop && drop.id === canvas.id ? ` drop-${drop.mode}` : "";
      return (
        <div key={canvas.id}>
          <div
            className={`tree-node${canvas.id === activeCanvasId ? " active" : ""}${dropClass}`}
            style={{ paddingLeft: depth * 16 + 4 }}
            draggable
            onDragStart={(event) => {
              dragIdRef.current = canvas.id;
              setDraggingId(canvas.id);
              event.dataTransfer.setData("text/plain", canvas.id);
              // Internal marker: the app shell never shows the import overlay
              // for a canvas-tree drag.
              event.dataTransfer.setData("text/x-picboard-canvas", canvas.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => { dragIdRef.current = null; setDraggingId(null); setDrop(null); }}
            onDragOver={(event) => dragOverNode(event, canvas)}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop((current) => current?.id === canvas.id ? null : current);
            }}
            onDrop={(event) => commitDrop(event, canvas)}
            onClick={() => onEnter(canvas.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ canvasId: canvas.id, x: event.clientX, y: event.clientY });
            }}
          >
            {children.length > 0
              ? <button className="tree-caret" aria-label={isOpen ? "收起" : "展开"} onClick={(event) => { event.stopPropagation(); toggle(canvas.id); }}>{isOpen ? "▾" : "▸"}</button>
              : <span className="tree-caret empty" aria-hidden="true" />}
            <span className="tree-icon" aria-hidden="true"><IconPage size={14} /></span>
            <span className="tree-label" title={canvas.name}>{canvas.name}</span>
            <span className="tree-count" title={`${canvas.nodes.length} 个节点`}>{canvas.nodes.length} 个节点</span>
            <button className="tree-add" title="新建子画布" aria-label={`在“${canvas.name}”内新建子画布`} onClick={(event) => { event.stopPropagation(); onCreateChild(canvas.id); }}><IconPlus size={13} /></button>
          </div>
          {children.length > 0 && <TreeBranch open={isOpen}>{renderNodes(canvas.id, depth + 1)}</TreeBranch>}
        </div>
      );
    });

  const menuTarget = menu ? canvases.find((canvas) => canvas.id === menu.canvasId) : null;

  return <div className="canvas-tree">
    <div className="tree-header">
      <strong>画布层级</strong>
      <button className="tree-header-add" title="新建根画布" aria-label="新建根画布" onClick={onCreateRoot}><IconPlus size={14} /></button>
    </div>
    <div className="tree-body">
      {renderNodes(null, 0)}
      {canvases.length === 0 && <p className="tree-empty">还没有画布</p>}
      {canvases.length > 0 && filterActive && visibleIds.size === 0 && <p className="tree-empty">没有匹配“{query.trim()}”的画布</p>}
    </div>
    {draggingId !== null && (
      <div
        className={`tree-root-drop${drop && drop.id === null ? " drag-over" : ""}`}
        onDragOver={(event) => {
          if (!dragIdRef.current) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDrop({ id: null, mode: "inside" });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop((current) => current?.id === null ? null : current);
        }}
        onDrop={(event) => commitDrop(event, null)}
      >
        拖到此处设为根画布
      </div>
    )}
    <ContextMenu menu={menu && menuTarget ? { x: menu.x, y: menu.y, items: nodeMenu(menuTarget) } : null} onClose={() => setMenu(null)} />
  </div>;
}
