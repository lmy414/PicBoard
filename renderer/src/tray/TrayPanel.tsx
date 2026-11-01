import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppState, ContentRecord, MainNavigation } from "../../../shared/image-board";
import { KIND_LABEL, buildPlacementIndex, contentTitle, relativeTime } from "../content/content-meta";
import { ContentCover, contentCoverSource } from "../library/ContentCover";
import { IconArrowLeft, IconCanvas, IconClipboard, IconCopy, IconExternalLink, IconTag, KindIcon } from "../ui/ContentIcons";
import { IconCheck, IconChevronDown, IconClose, IconDots, IconGear, IconPlus, IconSearch } from "../ui/Icons";
import { usePresence } from "../ui/motion";
import { hostErrorMessage } from "../pages/page-utils";
import {
  clampMenuPoint,
  filterTrayContents,
  isFreshRevision,
  isSearchShortcutKey,
  moveSelection,
  todayCount,
  trayTabCounts,
  TRAY_TABS,
  TRAY_TAB_LABEL,
  type TrayTab,
} from "./tray-model";
import "./tray.css";

const PAGE_SIZE = 100;
const MENU_ESTIMATE = { width: 188, height: 244 };
const COPY_FEEDBACK_MS = 1200;
const EXIT_MS = 140;
const ERROR_MS = 2600;

const EMPTY_STATE: AppState = {
  revision: 0,
  activeCanvasId: "",
  canvases: [],
  categories: [],
  contents: {},
  edges: [],
};

interface TrayMenuState {
  contentId: string;
  x: number;
  y: number;
  section: "root" | "category";
  newCategory: boolean;
}

interface TrayRow {
  content: ContentRecord;
  categoryName: string | null;
  canvasCount: number;
  index: number;
}

type ExitingRow = TrayRow;

interface TrayCardProps {
  content: ContentRecord;
  categoryName: string | null;
  canvasCount: number;
  selected: boolean;
  copied: boolean;
  expanded: boolean;
  confirming: boolean;
  phase: "enter" | "idle" | "exit";
  order: number;
  registerItem: (contentId: string, element: HTMLElement | null) => void;
  onCopy(contentId: string): void;
  onOpenMain(contentId: string): void;
  onToggleExpand(contentId: string): void;
  onMenu(x: number, y: number, contentId: string): void;
  onConfirmDelete(contentId: string): void;
  onCancelConfirm(): void;
}

const TrayCard = memo(function TrayCard({
  content,
  categoryName,
  canvasCount,
  selected,
  copied,
  expanded,
  confirming,
  phase,
  order,
  registerItem,
  onCopy,
  onOpenMain,
  onToggleExpand,
  onMenu,
  onConfirmDelete,
  onCancelConfirm,
}: TrayCardProps) {
  const cover = contentCoverSource(content);
  const isTextual = content.kind === "text" || content.kind === "richText";
  const [bodyText, setBodyText] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const itemRef = useRef<HTMLElement | null>(null);
  const setItemRef = useCallback(
    (element: HTMLElement | null) => {
      itemRef.current = element;
      registerItem(content.id, element);
    },
    [content.id, registerItem],
  );

  useEffect(() => {
    if (!expanded || !isTextual) return;
    let cancelled = false;
    setBodyState((current) => (current === "ready" ? current : "loading"));
    window.imageBoard
      .getContentBody(content.id)
      .then((body) => {
        if (cancelled) return;
        setBodyText(body.text);
        setBodyState("ready");
      })
      .catch(() => {
        if (!cancelled) setBodyState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, content.id, isTextual]);

  const copiedPresence = usePresence(copied, 120);

  return (
    <div
      ref={setItemRef}
      className={`tray-item motion-slide-left${phase === "idle" ? "" : ` is-${phase}`}${selected ? " is-selected" : ""}${confirming ? " is-confirming" : ""}`}
      data-motion={phase}
      style={{ order }}
      data-content-id={content.id}
      role="button"
      tabIndex={-1}
      aria-current={selected ? "true" : undefined}
      aria-label={`${KIND_LABEL[content.kind]}：${contentTitle(content)}`}
      onClick={() => onCopy(content.id)}
      onDoubleClick={() => onOpenMain(content.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY, content.id);
      }}
    >
      {cover ? (
        <ContentCover content={content} className="tray-thumb" />
      ) : (
        <span className="tray-item-icon">
          <KindIcon kind={content.kind} size={16} />
        </span>
      )}
      <span className="tray-item-main">
        <span className="tray-item-preview">{content.preview.trim() || "空白内容"}</span>
        <span className="tray-item-meta">
          <span className="tray-item-time">{relativeTime(content.lastUsedAt)}</span>
          {canvasCount > 0 ? (
            <span className="tray-item-badge">
              <IconCanvas size={11} />
              {canvasCount} 个画布
            </span>
          ) : null}
          {categoryName ? <span className="tray-item-category">{categoryName}</span> : null}
        </span>
      </span>
      <span className="tray-item-actions">
        <button
          type="button"
          className={`tray-item-chevron${expanded ? " is-open" : ""}`}
          title={expanded ? "收起预览 (Esc)" : "展开预览 (Space)"}
          aria-label={expanded ? "收起预览" : "展开预览"}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand(content.id);
          }}
        >
          <IconChevronDown size={13} />
        </button>
        <button
          type="button"
          className="tray-item-more"
          title="内容操作"
          aria-label="内容操作"
          onClick={(event) => {
            event.stopPropagation();
            onMenu(event.clientX, event.clientY, content.id);
          }}
        >
          <IconDots size={14} />
        </button>
      </span>

      <div className={`tray-expand${expanded ? " is-open" : ""}`} aria-hidden={!expanded}>
        <div className="tray-expand-inner" onClick={(event) => event.stopPropagation()}>
          {content.kind === "image" ? (
            <img
              className="tray-expand-image"
              src={window.imageBoard.imageUrl(content.id, "full")}
              alt={contentTitle(content)}
              draggable={false}
              decoding="async"
            />
          ) : null}
          {content.kind === "link" ? (
            <div className="tray-expand-url">{content.url ?? content.preview}</div>
          ) : null}
          {isTextual && expanded ? (
            bodyState === "error" ? (
              <div className="tray-expand-error">无法载入全文</div>
            ) : bodyState === "loading" || bodyText === null ? (
              <div className="tray-expand-loading">载入中…</div>
            ) : (
              <div className="tray-expand-text">{bodyText}</div>
            )
          ) : null}
        </div>
      </div>

      {copiedPresence.mounted ? (
        <span className="tray-copied motion-pop" data-motion={copiedPresence.phase}>
          <IconCheck size={11} />
          已复制
        </span>
      ) : null}

      {confirming ? (
        <div className="tray-confirm" role="alertdialog" aria-label="删除内容确认">
          <span className="tray-confirm-text">从所有画布删除，无法恢复</span>
          <span className="tray-confirm-actions">
            <button
              type="button"
              className="tray-confirm-delete"
              onClick={(event) => {
                event.stopPropagation();
                onConfirmDelete(content.id);
              }}
            >
              删除
            </button>
            <button
              type="button"
              className="tray-confirm-cancel"
              onClick={(event) => {
                event.stopPropagation();
                onCancelConfirm();
              }}
            >
              取消
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
});

/**
 * Clipboard flyout rendered inside the tray popup window. Props-free on
 * purpose: it owns its host access, revision guard, selection and menus.
 */
export function TrayPanel(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null);
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [tab, setTab] = useState<TrayTab>("all");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<TrayMenuState | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [exitingRows, setExitingRows] = useState<ExitingRow[]>([]);
  const [enteredIds, setEnteredIds] = useState<Set<string>>(() => new Set());
  const [showToken, setShowToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const revisionRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const previousRowsRef = useRef<Map<string, TrayRow>>(new Map());
  const enteredSeenRef = useRef<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefsRef = useRef<Map<string, HTMLElement>>(new Map());

  const applyState = useCallback((next: AppState) => {
    if (!isFreshRevision(revisionRef.current, next)) return;
    revisionRef.current = next.revision;
    setState(next);
  }, []);
  const applyStateRef = useRef(applyState);
  applyStateRef.current = applyState;

  const showError = useCallback((message: string) => {
    setError(message);
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => {
      setError(null);
      errorTimerRef.current = null;
    }, ERROR_MS);
  }, []);
  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  const markShown = useCallback(() => {
    setShowToken((token) => token + 1);
    setQuery("");
    setExpandedId(null);
    setConfirmingId(null);
    setMenu(null);
    setSelectedIndex(-1);
    setVisibleCount(PAGE_SIZE);
  }, []);
  const markShownRef = useRef(markShown);
  markShownRef.current = markShown;

  const refresh = useCallback(async () => {
    try {
      const next = await window.imageBoard.loadState();
      applyStateRef.current(next);
    } catch (error) {
      showErrorRef.current(hostErrorMessage(error, "无法载入历史"));
    }
  }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current();
    window.imageBoard
      .getDesktopSettings()
      .then((settings) => setCaptureEnabled(settings.captureEnabled))
      .catch(() => {});
    const off = window.imageBoard.onStateChanged((next) => applyStateRef.current(next));
    const onShow = () => {
      void refreshRef.current();
      markShownRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onShow();
    };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      off();
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const contents = useMemo(() => (state ? Object.values(state.contents) : []), [state]);
  const tabCounts = useMemo(() => trayTabCounts(contents), [contents]);
  const filtered = useMemo(() => filterTrayContents(contents, tab, query), [contents, tab, query]);
  const categoryNames = useMemo(
    () => new Map((state?.categories ?? []).map((entry) => [entry.id, entry.name] as const)),
    [state?.categories],
  );
  const placements = useMemo(() => buildPlacementIndex(state ?? EMPTY_STATE), [state]);
  const total = contents.length;
  const today = todayCount(contents, now);
  const paused = !captureEnabled;

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > visibleCount;
  const visibleKey = visible.map((content) => content.id).join("|");
  const selectedId = visible[selectedIndex]?.id ?? null;

  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  const contentsKey = contents.map((content) => content.id).join("|");

  // Newly captured contents enter once, before the first paint.
  useLayoutEffect(() => {
    const ids = new Set(contents.map((content) => content.id));
    const seen = enteredSeenRef.current;
    if (seen) {
      const fresh = [...ids].filter((id) => !seen.has(id));
      if (fresh.length > 0) setEnteredIds((current) => new Set([...current, ...fresh]));
    }
    enteredSeenRef.current = ids;
    // contentsKey covers identity changes of the same id set.
  }, [contentsKey, contents]);

  useEffect(() => {
    if (enteredIds.size === 0) return;
    const timer = window.setTimeout(() => setEnteredIds(new Set()), 360);
    return () => window.clearTimeout(timer);
  }, [enteredIds]);

  // Removed rows keep rendering in place for their exit animation.
  useLayoutEffect(() => {
    const current = new Map<string, TrayRow>();
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
    }, EXIT_MS);
  }, [visibleKey, categoryNames, placements]);

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [tab, query, showToken]);

  // Incremental rendering: mount the next page once the sentinel approaches.
  useEffect(() => {
    if (!hasMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => Math.min(filteredRef.current.length, current + PAGE_SIZE));
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, showToken]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filtered.length === 0) return -1;
      if (current < 0) return -1;
      return Math.min(current, filtered.length - 1);
    });
  }, [filtered]);

  useEffect(() => {
    if (!selectedId) return;
    itemRefsRef.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const menuPresence = usePresence(Boolean(menu), 120);
  const lastMenuRef = useRef<TrayMenuState | null>(null);
  if (menu) lastMenuRef.current = menu;
  const shownMenu = menu ?? lastMenuRef.current;
  const menuRefState = useRef<TrayMenuState | null>(null);
  menuRefState.current = menu;

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const point = clampMenuPoint(menu.x, menu.y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    setMenuPos(point);
  }, [menu]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const copyCard = useCallback((contentId: string) => {
    const index = filteredRef.current.findIndex((row) => row.id === contentId);
    if (index >= 0) setSelectedIndex(index);
    void window.imageBoard
      .copyContents([contentId])
      .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "复制失败")));
    setCopiedId(contentId);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedId(null);
      copiedTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }, []);

  const togglePreview = useCallback((contentId: string) => {
    setExpandedId((current) => (current === contentId ? null : contentId));
  }, []);

  const openMain = useCallback((navigate?: MainNavigation) => {
    void window.imageBoard
      .showMainWindow(navigate)
      .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "无法打开主窗口")));
  }, []);

  const toggleCapture = useCallback(() => {
    const next = !captureEnabled;
    void window.imageBoard
      .setDesktopSettings({ captureEnabled: next })
      .then((settings) => setCaptureEnabled(settings.captureEnabled))
      .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "无法更新记录状态")));
  }, [captureEnabled]);

  const registerItem = useCallback((contentId: string, element: HTMLElement | null) => {
    if (element) itemRefsRef.current.set(contentId, element);
    else itemRefsRef.current.delete(contentId);
  }, []);

  const openMenu = useCallback((x: number, y: number, contentId: string) => {
    const point = clampMenuPoint(x, y, MENU_ESTIMATE.width, MENU_ESTIMATE.height, window.innerWidth, window.innerHeight);
    setMenu({ contentId, x: point.x, y: point.y, section: "root", newCategory: false });
    setMenuPos(point);
  }, []);

  const confirmDelete = useCallback(
    (contentId: string) => {
      setConfirmingId(null);
      void window.imageBoard
        .deleteContents([contentId])
        .then((next) => applyStateRef.current(next))
        .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "删除失败")));
    },
    [],
  );

  const classifyAs = useCallback((contentId: string, categoryId: string | null) => {
    void window.imageBoard
      .classifyContents([contentId], categoryId)
      .then((next) => applyStateRef.current(next))
      .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "分类失败")));
  }, []);

  const createAndAssign = useCallback(
    (contentId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      void window.imageBoard
        .createCategory(trimmed)
        .then((created) => {
          applyStateRef.current(created);
          const match = [...created.categories].reverse().find((entry) => entry.name === trimmed);
          if (!match) return undefined;
          return window.imageBoard.classifyContents([contentId], match.id);
        })
        .then((next) => {
          if (next) applyStateRef.current(next);
        })
        .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "分类失败")));
    },
    [],
  );

  // Global keyboard: Escape peels layers, arrows/Enter/Space/Delete drive the
  // selection, printable keys focus the search field.
  const keydownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keydownRef.current = (event: KeyboardEvent) => {
    const target = event.target;
    const editable =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    if (event.key === "Escape") {
      if (menuRefState.current) {
        event.preventDefault();
        setMenu(null);
        return;
      }
      if (confirmingId) {
        event.preventDefault();
        setConfirmingId(null);
        return;
      }
      if (expandedId) {
        event.preventDefault();
        setExpandedId(null);
        return;
      }
      event.preventDefault();
      void window.imageBoard
        .hideTrayPanel()
        .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "无法隐藏窗口")));
      return;
    }

    if (menuRefState.current || editable) return;

    const length = filteredRef.current.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const direction: "ArrowDown" | "ArrowUp" = event.key;
      event.preventDefault();
      setSelectedIndex((current) => moveSelection(direction, current, length));
      return;
    }
    const currentId = length > 0 ? filteredRef.current[Math.min(Math.max(selectedIndex, 0), length - 1)]?.id ?? null : null;
    if (event.key === "Enter") {
      if (currentId) {
        event.preventDefault();
        copyCard(currentId);
      }
      return;
    }
    if (event.key === " ") {
      if (currentId) {
        event.preventDefault();
        togglePreview(currentId);
      }
      return;
    }
    if (event.key === "Delete") {
      if (currentId) {
        event.preventDefault();
        setConfirmingId(currentId);
      }
      return;
    }
    if (isSearchShortcutKey(event, editable)) {
      event.preventDefault();
      searchInputRef.current?.focus();
      setQuery((current) => current + event.key);
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => keydownRef.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const menuContentId = menu?.contentId ?? shownMenu?.contentId ?? null;
  const menuCategory = useMemo(() => {
    if (!menuContentId) return null;
    return state?.contents[menuContentId]?.categoryId ?? null;
  }, [menuContentId, state?.contents]);

  const newCategoryNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (menu?.newCategory) newCategoryNameRef.current?.focus();
  }, [menu?.newCategory]);

  const renderMenu = () => {
    if (!shownMenu || !menuPresence.mounted) return null;
    const section = shownMenu.section;
    return createPortal(
      <div
        ref={menuRef}
        className="tray-menu motion-pop"
        data-motion={menuPresence.phase}
        style={{ left: menuPos?.x ?? shownMenu.x, top: menuPos?.y ?? shownMenu.y }}
        role="menu"
        aria-label="内容操作"
      >
        {section === "root" ? (
          <>
            <button
              type="button"
              className="tray-menu-item"
              onClick={() => {
                copyCard(shownMenu.contentId);
                closeMenu();
              }}
            >
              <IconCopy size={13} />
              复制
            </button>
            <button
              type="button"
              className="tray-menu-item"
              onClick={() => {
                togglePreview(shownMenu.contentId);
                closeMenu();
              }}
            >
              预览
            </button>
            <button
              type="button"
              className="tray-menu-item"
              onClick={() => {
                openMain({ contentId: shownMenu.contentId });
                closeMenu();
              }}
            >
              <IconExternalLink size={13} />
              在主窗口打开
            </button>
            <button
              type="button"
              className="tray-menu-item"
              onClick={() => setMenu((current) => (current ? { ...current, section: "category", newCategory: false } : current))}
            >
              <IconTag size={13} />
              分类 ›
            </button>
            <div className="tray-menu-sep" />
            <button
              type="button"
              className="tray-menu-item is-danger"
              onClick={() => {
                setConfirmingId(shownMenu.contentId);
                closeMenu();
              }}
            >
              删除内容
            </button>
          </>
        ) : (
          <>
            <div className="tray-menu-head">
              <button
                type="button"
                className="tray-menu-back"
                aria-label="返回"
                onClick={() => setMenu((current) => (current ? { ...current, section: "root" } : current))}
              >
                <IconArrowLeft size={12} />
              </button>
              <span>分类</span>
            </div>
            <div className="tray-menu-list">
              {(state?.categories ?? []).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`tray-menu-item${menuCategory === entry.id ? " is-active" : ""}`}
                  onClick={() => {
                    classifyAs(shownMenu.contentId, entry.id);
                    closeMenu();
                  }}
                >
                  {entry.name}
                </button>
              ))}
              {menuCategory ? (
                <button
                  type="button"
                  className="tray-menu-item is-muted"
                  onClick={() => {
                    classifyAs(shownMenu.contentId, null);
                    closeMenu();
                  }}
                >
                  取消分类
                </button>
              ) : null}
            </div>
            {shownMenu.newCategory ? (
              <form
                className="tray-menu-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = newCategoryNameRef.current;
                  const name = input?.value ?? "";
                  if (!name.trim()) return;
                  createAndAssign(shownMenu.contentId, name);
                  closeMenu();
                }}
              >
                <input ref={newCategoryNameRef} className="tray-menu-input" placeholder="新分类名称" spellCheck={false} />
                <button type="submit" className="tray-menu-item is-primary">
                  <IconPlus size={12} />
                  创建
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="tray-menu-item"
                onClick={() => setMenu((current) => (current ? { ...current, newCategory: true } : current))}
              >
                <IconPlus size={12} />
                新分类
              </button>
            )}
          </>
        )}
      </div>,
      document.body,
    );
  };

  return (
    <div className="tray-panel">
      <div className="tray-card">
        <header className="tray-head">
          <span className="tray-logo" aria-hidden="true">
            <IconClipboard size={14} />
          </span>
          <strong className="tray-name">PicBoard</strong>
          <span className="tray-head-grow" />
          <button
            type="button"
            className={`tray-icon-button${captureEnabled ? "" : " is-paused"}`}
            title={captureEnabled ? "记录中（点击暂停）" : "已暂停（点击恢复）"}
            aria-pressed={captureEnabled}
            onClick={toggleCapture}
          >
            <span className="tray-record-dot" aria-hidden="true" />
            {captureEnabled ? "记录中" : "已暂停"}
          </button>
          <button type="button" className="tray-icon-button" title="打开主窗口" aria-label="打开主窗口" onClick={() => openMain()}>
            <IconExternalLink size={14} />
          </button>
          <button
            type="button"
            className="tray-icon-button"
            title="设置"
            aria-label="设置"
            onClick={() => openMain({ view: "settings" })}
          >
            <IconGear size={14} />
          </button>
        </header>

        <div className="tray-content motion-slide-up" data-motion="enter" key={showToken}>
          <div className="tray-tabs-row">
            <div className="tray-tabs" role="group" aria-label="内容类型">
              {TRAY_TABS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  className={`tray-tab${tab === entry ? " active" : ""}`}
                  aria-pressed={tab === entry}
                  onClick={() => setTab(entry)}
                >
                  {TRAY_TAB_LABEL[entry]}
                  <span>{tabCounts[entry]}</span>
                </button>
              ))}
            </div>
            <div className="tray-search">
              <IconSearch size={13} />
              <input
                ref={searchInputRef}
                value={query}
                placeholder="搜索内容"
                aria-label="搜索内容"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button type="button" className="tray-search-clear" aria-label="清除搜索" onClick={() => setQuery("")}>
                  <IconClose size={11} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="tray-stats">
            <span>
              今天 {today} 条 · 共 {total} 条
            </span>
            {paused ? <span className="tray-stats-paused">已暂停记录</span> : null}
            {error ? (
              <span className="tray-error motion-fade" data-motion="enter" role="alert">
                {error}
              </span>
            ) : null}
          </div>

          <div className="tray-list" ref={listRef}>
            {visible.map((content, index) => (
              <TrayCard
                key={content.id}
                content={content}
                categoryName={content.categoryId ? categoryNames.get(content.categoryId) ?? null : null}
                canvasCount={placements.get(content.id)?.length ?? 0}
                selected={selectedId === content.id}
                copied={copiedId === content.id}
                expanded={expandedId === content.id}
                confirming={confirmingId === content.id}
                phase={enteredIds.has(content.id) ? "enter" : "idle"}
                order={index * 2}
                registerItem={registerItem}
                onCopy={copyCard}
                onOpenMain={(contentId) => openMain({ contentId })}
                onToggleExpand={togglePreview}
                onMenu={openMenu}
                onConfirmDelete={confirmDelete}
                onCancelConfirm={() => setConfirmingId(null)}
              />
            ))}
            {exitingRows.map((row) => (
              <TrayCard
                key={`exit-${row.content.id}`}
                content={row.content}
                categoryName={row.categoryName}
                canvasCount={row.canvasCount}
                selected={false}
                copied={false}
                expanded={false}
                confirming={false}
                phase="exit"
                order={row.index * 2 + 1}
                registerItem={registerItem}
                onCopy={copyCard}
                onOpenMain={(contentId) => openMain({ contentId })}
                onToggleExpand={togglePreview}
                onMenu={openMenu}
                onConfirmDelete={confirmDelete}
                onCancelConfirm={() => setConfirmingId(null)}
              />
            ))}
            {hasMore ? (
              <div ref={sentinelRef} className="tray-sentinel">
                继续下滑加载更多
              </div>
            ) : null}
            {total === 0 ? (
              <div className="tray-empty">
                <span className="tray-empty-icon">
                  <IconClipboard size={24} />
                </span>
                <strong>复制的内容会自动出现在这里</strong>
                <p>在任意应用中复制文字、链接或图片，无需打开 PicBoard 也会被记录。</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="tray-empty">
                <span className="tray-empty-icon">
                  <IconSearch size={22} />
                </span>
                <strong>没有符合条件的内容</strong>
                <p>换个关键词，或切换到其他类型。</p>
              </div>
            ) : null}
          </div>

          <footer className="tray-foot">
            <button type="button" className="tray-foot-main" onClick={() => openMain()}>
              打开 PicBoard
            </button>
            <button
              type="button"
              className="tray-foot-quit"
              onClick={() =>
                void window.imageBoard
                  .quitApp()
                  .catch((error: unknown) => showErrorRef.current(hostErrorMessage(error, "无法退出")))
              }
            >
              退出
            </button>
          </footer>
        </div>
      </div>
      {renderMenu()}
    </div>
  );
}

export default TrayPanel;
