import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppState, ContentKind, ContentRecord } from "../../../shared/image-board";
import { KIND_LABEL, buildPlacementIndex, contentTitle, matchesQuery, relativeTime } from "../content/content-meta";
import { IconClipboard, KindIcon } from "../ui/ContentIcons";
import { IconClose, IconSearch } from "../ui/Icons";
import { usePresence } from "../ui/motion";
import { ContentCover, contentCoverSource } from "../library/ContentCover";
import "./history.css";

export interface HistoryDrawerProps {
  state: AppState;
  open: boolean;
  captureEnabled: boolean;
  onToggleCapture(next: boolean): void;
  onClose(): void;
  onOpen(contentId: string): void;
  onQuickActions(event: ReactMouseEvent<HTMLElement>, contentId: string): void;
  /** Pointer released at client coords while dragging an item; returns true when it was placed on the canvas. */
  onDropToCanvas(contentId: string, clientX: number, clientY: number): boolean;
}

type KindFilter = "all" | ContentKind;

const INITIAL_ITEMS = 100;
const PAGE_SIZE = 100;
const DRAG_THRESHOLD = 4;

interface DragSession {
  pointerId: number;
  content: ContentRecord;
  sourceEl: HTMLElement;
  sourceRect: DOMRect;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  ghost: HTMLDivElement | null;
  started: boolean;
  overCanvas: boolean;
  frame: number | null;
}

interface HistoryItemProps {
  content: ContentRecord;
  categoryName: string | null;
  canvasCount: number;
  time: string;
  phase: "enter" | "idle" | "exit";
  order: number;
  onOpen(contentId: string): void;
  onQuickActions(event: ReactMouseEvent<HTMLElement>, contentId: string): void;
  onPointerDown(event: React.PointerEvent<HTMLElement>, content: ContentRecord): void;
}

const HistoryItem = memo(function HistoryItem({
  content,
  categoryName,
  canvasCount,
  time,
  phase,
  order,
  onOpen,
  onQuickActions,
  onPointerDown,
}: HistoryItemProps) {
  const preview =
    content.kind === "image"
      ? content.image?.fileName ?? contentTitle(content)
      : content.preview.trim() || "空白内容";
  const cover = contentCoverSource(content);

  return (
    <div
      role="button"
      tabIndex={0}
      className={`hist-item${phase === "idle" ? "" : " motion-slide-left"}`}
      data-motion={phase}
      style={{ order }}
      aria-label={`${KIND_LABEL[content.kind]}：${contentTitle(content)}`}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => onPointerDown(event, content)}
      onDoubleClick={() => onOpen(content.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onQuickActions(event, content.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onOpen(content.id);
        }
      }}
    >
      {cover ? (
        <ContentCover content={content} className="hist-thumb" />
      ) : (
        <span className="hist-icon">
          <KindIcon kind={content.kind} size={15} />
        </span>
      )}
      <span className="hist-text">
        <span className="hist-preview">{preview}</span>
        <span className="hist-meta">
          <span className="hist-time">{time}</span>
          {categoryName ? <span className="hist-category">{categoryName}</span> : null}
          {canvasCount > 0 ? <span className="hist-badge">{canvasCount} 个画布</span> : null}
        </span>
      </span>
    </div>
  );
});

/**
 * Clipboard history panel. Stays mounted, slides in over the canvas slot, and
 * renders incrementally so a large history stays responsive. Dragging uses
 * pointer events only (never native HTML5 drag) so the canvas owns the drop.
 */
export function HistoryDrawer(props: HistoryDrawerProps) {
  const { state, open, captureEnabled } = props;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [visibleCount, setVisibleCount] = useState(INITIAL_ITEMS);
  const [now, setNow] = useState(() => Date.now());
  const [entered, setEntered] = useState<Set<string>>(() => new Set());
  const [exitingRows, setExitingRows] = useState<Array<{ content: ContentRecord; categoryName: string | null; canvasCount: number; index: number }>>([]);
  const previousRowsRef = useRef<Map<string, { content: ContentRecord; categoryName: string | null; canvasCount: number; index: number }>>(new Map());
  const exitTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) panel.removeAttribute("inert");
    else {
      panel.setAttribute("inert", "");
      const active = document.activeElement;
      if (active instanceof HTMLElement && panel.contains(active)) active.blur();
    }
  }, [open]);

  const applyQuery = (value: string) => {
    setQuery(value);
    setVisibleCount(INITIAL_ITEMS);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const applyKind = (value: KindFilter) => {
    setKind(value);
    setVisibleCount(INITIAL_ITEMS);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  // Newly captured contents animate in exactly once, before the first paint.
  useLayoutEffect(() => {
    const ids = new Set(Object.keys(state.contents));
    const seen = seenRef.current;
    if (seen) {
      const fresh = [...ids].filter((id) => !seen.has(id));
      if (fresh.length > 0) {
        setEntered((current) => {
          const next = new Set(current);
          for (const id of fresh) next.add(id);
          return next;
        });
      }
    }
    seenRef.current = ids;
  }, [state.contents]);

  useEffect(() => {
    if (entered.size === 0) return;
    const timer = window.setTimeout(() => setEntered(new Set()), 340);
    return () => window.clearTimeout(timer);
  }, [entered]);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  const categoryNames = useMemo(
    () => new Map(state.categories.map((entry) => [entry.id, entry.name] as const)),
    [state.categories],
  );
  const placements = useMemo(() => buildPlacementIndex(state), [state.canvases]);

  const filtered = useMemo(() => {
    return Object.values(state.contents)
      .filter((content) => (kind === "all" ? true : content.kind === kind))
      .filter((content) => matchesQuery(content, query))
      .sort((left, right) => {
        const a = Date.parse(left.lastUsedAt);
        const b = Date.parse(right.lastUsedAt);
        return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
      });
  }, [state.contents, kind, query]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || !open || filtered.length <= visibleCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => Math.min(filtered.length, current + PAGE_SIZE));
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtered.length, visibleCount, open]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;
  const visibleKey = visible.map((content) => content.id).join("|");
  const totalContents = Object.keys(state.contents).length;
  const emptyKind: "none" | "paused" | "filter" | null =
    filtered.length === 0
      ? totalContents === 0
        ? captureEnabled
          ? "none"
          : "paused"
        : "filter"
      : null;
  const emptyPresence = usePresence(Boolean(emptyKind), 120);
  const lastEmptyKindRef = useRef<"none" | "paused" | "filter">("none");
  if (emptyKind) lastEmptyKindRef.current = emptyKind;
  const shownEmpty = emptyKind ?? lastEmptyKindRef.current;
  const showList = filtered.length > 0 || exitingRows.length > 0;

  useLayoutEffect(() => {
    const current = new Map<string, { content: ContentRecord; categoryName: string | null; canvasCount: number; index: number }>();
    visible.forEach((content, index) => {
      current.set(content.id, {
        content,
        categoryName: content.categoryId ? categoryNames.get(content.categoryId) ?? null : null,
        canvasCount: placements.get(content.id)?.length ?? 0,
        index,
      });
    });
    const removed = [...previousRowsRef.current.values()].filter((row) => !current.has(row.content.id));
    previousRowsRef.current = current;
    if (removed.length === 0) return;
    setExitingRows((existing) => {
      const ids = new Set(removed.map((row) => row.content.id));
      return [...existing.filter((row) => !ids.has(row.content.id)), ...removed];
    });
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    exitTimerRef.current = window.setTimeout(() => {
      setExitingRows([]);
      exitTimerRef.current = null;
    }, 140);
  }, [visibleKey, categoryNames, placements]);

  // ---- pointer drag ------------------------------------------------------
  const applyGhostPosition = (session: DragSession) => {
    const ghost = session.ghost;
    if (!ghost) return;
    ghost.style.transform = `translate3d(${session.clientX + 12}px, ${session.clientY + 8}px, 0)`;
    const under = document.elementFromPoint(session.clientX, session.clientY);
    const overCanvas = Boolean(under?.closest?.(".canvas-viewport"));
    if (overCanvas !== session.overCanvas) {
      session.overCanvas = overCanvas;
      ghost.classList.toggle("is-over-canvas", overCanvas);
    }
  };

  const createGhost = (session: DragSession): HTMLDivElement => {
    const ghost = document.createElement("div");
    ghost.className = "hist-ghost";
    const card = document.createElement("div");
    card.className = "hist-ghost-card";
    const content = session.content;
    if (content.kind === "image" && content.image) {
      const thumb = document.createElement("img");
      thumb.className = "hist-ghost-thumb";
      thumb.src = window.imageBoard.imageUrl(content.id, "thumb");
      thumb.alt = "";
      thumb.draggable = false;
      card.append(thumb);
    } else {
      const tile = document.createElement("span");
      tile.className = "hist-ghost-icon";
      const icon = session.sourceEl.querySelector("svg");
      if (icon) tile.append(icon.cloneNode(true));
      card.append(tile);
    }
    const text = document.createElement("span");
    text.className = "hist-ghost-text";
    text.textContent = contentTitle(content);
    card.append(text);
    ghost.append(card);
    ghost.style.transform = `translate3d(${session.clientX + 12}px, ${session.clientY + 8}px, 0)`;
    document.body.append(ghost);
    return ghost;
  };

  const removeGhost = (ghost: HTMLDivElement | null, placed: boolean, session: DragSession) => {
    if (!ghost) return;
    if (placed) {
      ghost.classList.add("is-dropped");
      ghost.style.transform = `translate3d(${session.clientX + 12}px, ${session.clientY + 8}px, 0) scale(.62)`;
    } else {
      ghost.classList.add("is-returning");
      ghost.style.transform = `translate3d(${session.sourceRect.left}px, ${session.sourceRect.top}px, 0) scale(.9)`;
    }
    ghost.style.opacity = "0";
    const finish = () => ghost.remove();
    ghost.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 260);
  };

  const endDrag = (cancel: boolean, clientX: number, clientY: number) => {
    const session = dragRef.current;
    if (!session) return;
    dragRef.current = null;
    if (session.frame !== null) window.cancelAnimationFrame(session.frame);
    document.body.classList.remove("hist-dragging");
    session.sourceEl.classList.remove("hist-item-dragging");
    if (session.sourceEl.hasPointerCapture(session.pointerId)) {
      session.sourceEl.releasePointerCapture(session.pointerId);
    }
    if (!session.started) return;
    session.clientX = clientX;
    session.clientY = clientY;
    let placed = false;
    if (!cancel) {
      try {
        placed = propsRef.current.onDropToCanvas(session.content.id, clientX, clientY);
      } catch {
        placed = false;
      }
    }
    removeGhost(session.ghost, placed, session);
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      session.clientX = event.clientX;
      session.clientY = event.clientY;
      if (!session.started) {
        if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_THRESHOLD) {
          return;
        }
        session.started = true;
        session.ghost = createGhost(session);
        document.body.classList.add("hist-dragging");
        session.sourceEl.classList.add("hist-item-dragging");
        try {
          session.sourceEl.setPointerCapture(session.pointerId);
        } catch {
          // Capture is an optimisation; the window listeners still track.
        }
      }
      if (event.cancelable) event.preventDefault();
      if (session.frame === null) {
        session.frame = window.requestAnimationFrame(() => {
          session.frame = null;
          applyGhostPosition(session);
        });
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      endDrag(false, event.clientX, event.clientY);
    };
    const onPointerCancel = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      endDrag(true, event.clientX, event.clientY);
    };
    const onBlur = () => {
      const session = dragRef.current;
      if (session?.started) endDrag(true, session.clientX, session.clientY);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current?.started) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(true, dragRef.current.clientX, dragRef.current.clientY);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown, true);
      const session = dragRef.current;
      if (session) {
        dragRef.current = null;
        if (session.frame !== null) window.cancelAnimationFrame(session.frame);
        document.body.classList.remove("hist-dragging");
        session.sourceEl.classList.remove("hist-item-dragging");
        session.ghost?.remove();
      }
    };
  }, []);

  const handleItemPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, content: ContentRecord) => {
    if (event.button !== 0 || dragRef.current) return;
    const sourceEl = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      content,
      sourceEl,
      sourceRect: sourceEl.getBoundingClientRect(),
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      ghost: null,
      started: false,
      overCanvas: false,
      frame: null,
    };
  }, []);

  const handleOpen = useCallback((contentId: string) => propsRef.current.onOpen(contentId), []);
  const handleQuickActions = useCallback(
    (event: ReactMouseEvent<HTMLElement>, contentId: string) => propsRef.current.onQuickActions(event, contentId),
    [],
  );

  return (
    <aside className={`hist-drawer${open ? " is-open" : ""}`} aria-hidden={!open} aria-label="剪贴板历史">
      <div ref={panelRef} className="hist-panel" role="complementary" aria-label="剪贴板历史面板">
        <header className="hist-header">
          <div className="hist-title-row">
            <h2 className="hist-title">剪贴板历史</h2>
            <span className="hist-count">{filtered.length}</span>
            <button type="button" className="hist-close" aria-label="关闭剪贴板历史" title="关闭" onClick={props.onClose}>
              <IconClose size={14} />
            </button>
          </div>

          <div className="hist-controls">
            <button
              type="button"
              className={`hist-record${captureEnabled ? "" : " is-paused"}`}
              aria-pressed={captureEnabled}
              title={captureEnabled ? "暂停记录剪贴板" : "恢复记录剪贴板"}
              onClick={() => props.onToggleCapture(!captureEnabled)}
            >
              <span className="hist-switch" aria-hidden="true">
                <span className="hist-switch-knob" />
              </span>
              {captureEnabled ? "记录中" : "已暂停"}
            </button>
            <div className="hist-search">
              <IconSearch size={13} />
              <input
                value={query}
                placeholder="搜索历史"
                aria-label="搜索剪贴板历史"
                spellCheck={false}
                onChange={(event) => applyQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    applyQuery("");
                  }
                }}
              />
              {query ? (
                <button type="button" className="hist-search-clear" aria-label="清除搜索" onClick={() => applyQuery("")}>
                  <IconClose size={11} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="hist-kinds" role="group" aria-label="按类型筛选">
            <button
              type="button"
              className={`hist-kind-all${kind === "all" ? " active" : ""}`}
              aria-pressed={kind === "all"}
              title="全部类型"
              onClick={() => applyKind("all")}
            >
              全部
            </button>
            {(["text", "richText", "link", "image"] as ContentKind[]).map((entry) => (
              <button
                key={entry}
                type="button"
                className={kind === entry ? "active" : ""}
                aria-pressed={kind === entry}
                aria-label={KIND_LABEL[entry]}
                title={KIND_LABEL[entry]}
                onClick={() => applyKind(entry)}
              >
                <KindIcon kind={entry} size={13} />
              </button>
            ))}
          </div>
        </header>

        <div className="hist-body">
        {showList ? (
          <div ref={listRef} className="hist-list">
            {visible.map((content, index) => (
              <HistoryItem
                key={content.id}
                content={content}
                categoryName={content.categoryId ? categoryNames.get(content.categoryId) ?? null : null}
                canvasCount={placements.get(content.id)?.length ?? 0}
                time={relativeTime(content.lastUsedAt, now)}
                phase={entered.has(content.id) ? "enter" : "idle"}
                order={index * 2}
                onOpen={handleOpen}
                onQuickActions={handleQuickActions}
                onPointerDown={handleItemPointerDown}
              />
            ))}
            {exitingRows.map((row) => (
              <HistoryItem
                key={`exit-${row.content.id}`}
                content={row.content}
                categoryName={row.categoryName}
                canvasCount={row.canvasCount}
                time={relativeTime(row.content.lastUsedAt, now)}
                phase="exit"
                order={row.index * 2 + 1}
                onOpen={handleOpen}
                onQuickActions={handleQuickActions}
                onPointerDown={handleItemPointerDown}
              />
            ))}
            {hasMore ? (
              <div ref={sentinelRef} className="hist-sentinel">
                继续下滑加载更多
              </div>
            ) : null}
          </div>
        ) : null}
        {emptyPresence.mounted ? (
          <div
            className="hist-empty motion-fade"
            data-motion={emptyPresence.phase}
            aria-hidden={!emptyKind || undefined}
          >
            <span className="hist-empty-icon">
              <IconClipboard size={24} />
            </span>
            {shownEmpty === "filter" ? (
              <>
                <strong>没有符合条件的内容</strong>
                <p>换个关键词，或切换到其他类型。</p>
                <button
                  type="button"
                  className="hist-empty-action"
                  onClick={() => {
                    applyQuery("");
                    applyKind("all");
                  }}
                >
                  清除筛选
                </button>
              </>
            ) : (
              <>
                <strong>{shownEmpty === "none" ? "复制的内容会自动出现在这里" : "剪贴板记录已暂停"}</strong>
                <p>
                  {shownEmpty === "none"
                    ? "复制文字、链接或图片后，无需打开 PicBoard 也会被记录。把它们拖到画布上即可使用。"
                    : "重新开启记录后，新的复制内容会出现在这里；已有历史不会被删除。"}
                </p>
              </>
            )}
          </div>
        ) : null}
        </div>
      </div>
    </aside>
  );
}
