import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppState, ContentRecord } from "../../../shared/image-board";
import { KIND_LABEL, KIND_ORDER, buildPlacementIndex, contentTitle, displayContentKind, matchesContentKind, matchesQuery, relativeTime } from "../content/content-meta";
import type { DisplayContentKind } from "../content/content-meta";
import { IconClipboard, KindIcon } from "../ui/ContentIcons";
import { IconChevronDown, IconClose, IconSearch } from "../ui/Icons";
import { usePresence } from "../ui/motion";
import { ContentCover, contentCoverSource } from "./ContentCover";
import "./library.css";

export interface LibraryViewProps {
  state: AppState;
  toolbarHost?: HTMLElement | null;
  selectedIds: string[];
  onSelect(contentId: string, toggle: boolean): void;
  onClearSelection(): void;
  onOpen(contentId: string): void;
  onQuickActions(event: ReactMouseEvent<HTMLElement> | null, contentId: string): void;
}

type KindFilter = "all" | DisplayContentKind;
type TimeFilter = "all" | "today" | "week" | "month";

interface CardActions {
  onSelect(contentId: string, toggle: boolean): void;
  onOpen(contentId: string): void;
  onQuickActions(event: ReactMouseEvent<HTMLElement> | null, contentId: string): void;
}

const CardActionsContext = createContext<CardActions | null>(null);

interface CardSnapshot {
  content: ContentRecord;
  categoryName: string | null;
  canvasCount: number;
  index: number;
}

interface ExitingCard extends CardSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
}

const TIME_OPTIONS: Array<{ value: TimeFilter; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "week", label: "7 天内" },
  { value: "month", label: "30 天内" },
];

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

interface LibraryCardProps {
  content: ContentRecord;
  categoryName: string | null;
  canvasCount: number;
  selected: boolean;
  index: number;
  phase: "enter" | "idle";
  registerCard: (contentId: string, element: HTMLElement | null) => void;
}

const LibraryCard = memo(function LibraryCard({
  content,
  categoryName,
  canvasCount,
  selected,
  index,
  phase,
  registerCard,
}: LibraryCardProps) {
  const actions = useContext(CardActionsContext);
  const setCardRef = useCallback(
    (element: HTMLElement | null) => registerCard(content.id, element),
    [content.id, registerCard],
  );
  if (!actions) return null;
  const title = contentTitle(content);
  const time = relativeTime(content.createdAt);
  const cover = contentCoverSource(content);
  const reducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const delay = phase === "enter" && !reducedMotion ? `${Math.min(index, 14) * 18}ms` : undefined;

  return (
    <article
      ref={setCardRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${KIND_LABEL[content.kind]}：${title}`}
      className={`lib-card motion-pop${selected ? " selected" : ""}`}
      data-motion={phase}
      style={delay ? { animationDelay: delay } : undefined}
      onClick={(event) => actions.onSelect(content.id, event.shiftKey)}
      onDoubleClick={() => actions.onOpen(content.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        actions.onQuickActions(event, content.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          actions.onOpen(content.id);
        } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          actions.onQuickActions(null, content.id);
        }
      }}
    >
      {cover ? (
        <div className="lib-card-thumb">
          <ContentCover content={content} />
        </div>
      ) : null}

      <div className="lib-card-body">
        {content.kind === "link" ? (
          <>
            <strong className="lib-card-domain">{title}</strong>
            <p className="lib-card-url">{content.url ?? content.preview}</p>
          </>
        ) : content.kind === "image" ? (
          <p className="lib-card-preview lib-card-preview-image">{content.image?.fileName ?? title}</p>
        ) : (
          <p className="lib-card-preview">{content.preview.trim() || "空白内容"}</p>
        )}
      </div>

      <footer className="lib-card-footer">
        <span className="lib-card-kind">
          <KindIcon kind={content.kind} size={13} />
          {categoryName ?? "未分类"}
        </span>
        <span className="lib-card-meta">
          <span className="lib-card-time">{time}</span>
          <span className={canvasCount > 0 ? "lib-card-canvases" : "lib-card-canvases is-empty"}>
            {canvasCount} 个画布
          </span>
        </span>
      </footer>
    </article>
  );
});

/**
 * Category library across every content kind, filtered by search, kind,
 * category and created time. Selection state lives in the app shell.
 */
export function LibraryView(props: LibraryViewProps) {
  const { state, selectedIds } = props;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [category, setCategory] = useState("all");
  const [time, setTime] = useState<TimeFilter>("all");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [query, kind, category, time]);

  const actionsRef = useRef(props);
  actionsRef.current = props;
  const actions = useMemo<CardActions>(
    () => ({
      onSelect: (contentId, toggle) => actionsRef.current.onSelect(contentId, toggle),
      onOpen: (contentId) => actionsRef.current.onOpen(contentId),
      onQuickActions: (event, contentId) => actionsRef.current.onQuickActions(event, contentId),
    }),
    [],
  );

  const allContents = useMemo(() => Object.values(state.contents), [state.contents]);
  const kindCounts = useMemo(() => {
    const counts: Record<DisplayContentKind, number> = { richText: 0, link: 0, image: 0 };
    for (const content of allContents) counts[displayContentKind(content.kind)] += 1;
    return counts;
  }, [allContents]);

  const categoryNames = useMemo(
    () => new Map(state.categories.map((entry) => [entry.id, entry.name] as const)),
    [state.categories],
  );
  const placements = useMemo(() => buildPlacementIndex(state), [state.canvases]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const today = startOfToday(now);
    const thresholds: Record<TimeFilter, number> = {
      all: 0,
      today,
      week: now - 7 * 86_400_000,
      month: now - 30 * 86_400_000,
    };
    return allContents
      .filter((content) => {
        if (!matchesContentKind(content, kind)) return false;
        if (category === "none" && content.categoryId !== null) return false;
        if (category !== "all" && category !== "none" && content.categoryId !== category) return false;
        if (time !== "all") {
          const created = Date.parse(content.createdAt);
          if (!Number.isFinite(created) || created < thresholds[time]) return false;
        }
        return matchesQuery(content, query);
      })
      .sort((left, right) => {
        const a = Date.parse(left.createdAt);
        const b = Date.parse(right.createdAt);
        return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
      });
  }, [allContents, query, kind, category, time]);

  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const cardRectsRef = useRef(new Map<string, { left: number; top: number; width: number; height: number }>());
  const previousCardsRef = useRef(new Map<string, CardSnapshot>());
  const [exitingCards, setExitingCards] = useState<ExitingCard[]>([]);
  const exitTimerRef = useRef<number | null>(null);

  const registerCard = useCallback((contentId: string, element: HTMLElement | null) => {
    if (element) cardElementsRef.current.set(contentId, element);
    else cardElementsRef.current.delete(contentId);
  }, []);
  const ignoreCard = useCallback(() => {}, []);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const current = new Map<string, CardSnapshot>();
    filtered.forEach((content, index) => {
      current.set(content.id, {
        content,
        categoryName: content.categoryId ? categoryNames.get(content.categoryId) ?? "未分类" : null,
        canvasCount: placements.get(content.id)?.length ?? 0,
        index,
      });
    });

    const removed = [...previousCardsRef.current.values()].filter((row) => !current.has(row.content.id));
    if (removed.length > 0) {
      const snapshots = removed.flatMap((row) => {
        const rect = cardRectsRef.current.get(row.content.id);
        return rect ? [{ ...row, ...rect }] : [];
      });
      if (snapshots.length > 0) {
        setExitingCards((existing) => {
          const ids = new Set(snapshots.map((row) => row.content.id));
          return [...existing.filter((row) => !ids.has(row.content.id)), ...snapshots];
        });
        if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = window.setTimeout(() => {
          setExitingCards([]);
          exitTimerRef.current = null;
        }, 140);
      }
    }
    previousCardsRef.current = current;

    const rects = new Map<string, { left: number; top: number; width: number; height: number }>();
    if (grid) {
      for (const id of current.keys()) {
        const element = cardElementsRef.current.get(id);
        if (!element) continue;
        // Layout offsets are stable during entry transforms and independent of scroll.
        rects.set(id, {
          left: element.offsetLeft,
          top: element.offsetTop,
          width: element.offsetWidth,
          height: element.offsetHeight,
        });
      }
    }
    cardRectsRef.current = rects;
  }, [filtered, categoryNames, placements]);

  const emptyKind: "none" | "filter" | null =
    allContents.length === 0 ? "none" : filtered.length === 0 ? "filter" : null;
  const emptyPresence = usePresence(Boolean(emptyKind), 120);
  const lastEmptyKindRef = useRef<"none" | "filter">("none");
  if (emptyKind) lastEmptyKindRef.current = emptyKind;
  const shownEmpty = emptyKind ?? lastEmptyKindRef.current;
  const showGrid = filtered.length > 0 || exitingCards.length > 0;

  const filtersActive = query.trim().length > 0 || kind !== "all" || category !== "all" || time !== "all";

  const resetFilters = () => {
    setQuery("");
    setKind("all");
    setCategory("all");
    setTime("all");
  };

  const toolbar = (
        <div className="lib-toolbar" role="toolbar" aria-label="分类库工具">
          <div className="lib-toolbar-row">
            <div className="lib-search">
              <IconSearch size={14} />
              <input
                value={query}
                placeholder="搜索内容"
                aria-label="搜索内容"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query ? (
                <button type="button" className="lib-search-clear" aria-label="清除搜索" onClick={() => setQuery("")}>
                  <IconClose size={12} />
                </button>
              ) : null}
            </div>

            <div className="lib-kind-chips" role="group" aria-label="按类型筛选">
              <button
                type="button"
                className={kind === "all" ? "active" : ""}
                aria-pressed={kind === "all"}
                onClick={() => setKind("all")}
              >
                全部<span>{allContents.length}</span>
              </button>
              {KIND_ORDER.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={kind === entry ? "active" : ""}
                  aria-pressed={kind === entry}
                  onClick={() => setKind(entry)}
                >
                  {KIND_LABEL[entry]}
                  <span>{kindCounts[entry]}</span>
                </button>
              ))}
            </div>

            <div className="lib-filters">
              <span className="lib-select-wrap">
                <select
                  className="lib-select"
                  value={category}
                  aria-label="按分类筛选"
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="all">全部分类</option>
                  <option value="none">未分类</option>
                  {state.categories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={12} />
              </span>
              <span className="lib-select-wrap">
                <select
                  className="lib-select"
                  value={time}
                  aria-label="按创建时间筛选"
                  onChange={(event) => setTime(event.target.value as TimeFilter)}
                >
                  {TIME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <IconChevronDown size={12} />
              </span>
            </div>
          <div className="lib-summary">
            <span>
              {filtersActive ? `筛选出 ${filtered.length} 项 · 共 ${allContents.length} 项` : `共 ${allContents.length} 项`}
            </span>
            {selectedIds.length > 0 ? (
              <span className="lib-selection">
                已选 {selectedIds.length} 项
                <button type="button" aria-label="操作选中内容" onClick={(event) => props.onQuickActions(event, selectedIds[0])}>操作</button>
                <button type="button" onClick={props.onClearSelection}>
                  清除选择
                </button>
              </span>
            ) : null}
          </div>
          </div>
        </div>
  );

  return (
    <CardActionsContext.Provider value={actions}>
      <section className="lib-view" aria-label="分类库">
        {props.toolbarHost ? createPortal(toolbar, props.toolbarHost) : props.toolbarHost === undefined ? toolbar : null}

        <div className="lib-body">
        {showGrid ? (
          <div
            ref={gridRef}
            className="lib-grid"
            onClick={(event) => {
              if ((event.target as Element).closest(".lib-card")) return;
              props.onClearSelection();
            }}
          >
            {filtered.map((content, index) => (
              <LibraryCard
                key={content.id}
                content={content}
                categoryName={content.categoryId ? categoryNames.get(content.categoryId) ?? "未分类" : null}
                canvasCount={placements.get(content.id)?.length ?? 0}
                selected={selected.has(content.id)}
                index={index}
                phase="enter"
                registerCard={registerCard}
              />
            ))}
            {exitingCards.length > 0 ? (
              <div className="lib-exit-layer" aria-hidden="true">
                {exitingCards.map((card) => (
                  <div
                    key={`exit-${card.content.id}`}
                    className="lib-exit-card motion-pop"
                    data-motion="exit"
                    style={{ left: card.left, top: card.top, width: card.width, height: card.height }}
                  >
                    <LibraryCard
                      content={card.content}
                      categoryName={card.categoryName}
                      canvasCount={card.canvasCount}
                      selected={false}
                      index={0}
                      phase="idle"
                      registerCard={ignoreCard}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {emptyPresence.mounted ? (
          <div
            className="lib-empty motion-fade"
            data-motion={emptyPresence.phase}
            aria-hidden={!emptyKind || undefined}
          >
            {shownEmpty === "none" ? (
              <>
                <span className="lib-empty-icon">
                  <IconClipboard size={26} />
                </span>
                <strong>还没有内容</strong>
                <p>复制文字、链接或图片后会自动出现在这里，也可以把历史记录拖到画布上。</p>
              </>
            ) : (
              <>
                <span className="lib-empty-icon">
                  <IconSearch size={24} />
                </span>
                <strong>没有符合条件的内容</strong>
                <p>换个关键词，或放宽类型、分类与时间筛选。</p>
                <button type="button" className="lib-empty-action" onClick={resetFilters}>
                  清除筛选
                </button>
              </>
            )}
          </div>
        ) : null}
        </div>
      </section>
    </CardActionsContext.Provider>
  );
}
