import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment } from "react";
import type {
  AppState,
  CanvasFrame,
  CanvasPoint,
  CanvasRecord,
  CanvasViewport,
  ContentRecord,
  DesktopSettings,
  DesktopSettingsPatch,
  ImportViewport,
  MainNavigation,
  NewContentInput,
  WindowResizeDirection,
} from "../../shared/image-board";
import { applySelection, mergeSelection } from "../../shared/canvas-selection";
import { readCanvasAppearance, saveCanvasAppearance, type CanvasAppearance } from "./canvas/canvas-appearance";
import { CanvasStage, type CanvasStageHandle } from "./canvas/CanvasStage";
import { contentTitle, isHttpUrl } from "./content/content-meta";
import { HistoryDrawer } from "./history/HistoryDrawer";
import { LibraryView } from "./library/LibraryView";
import { ContentPage } from "./pages/ContentPage";
import { IconArrowLeft } from "./ui/ContentIcons";
import { CanvasTree, ContextMenu } from "./ui/CanvasTree";
import { CanvasDock, type CanvasTool } from "./ui/CanvasDock";
import { ContentActions, type ContentActionContext, type PanelAnchor } from "./ui/ContentActions";
import { SettingsPage, SettingsNavigation, type SettingsSection } from "./ui/SettingsPage";
import { IconClose, IconDots, IconFolder, IconGear, IconGrid, IconMinus, IconPanelLeft, IconSearch } from "./ui/Icons";
import { ToastView, toastChannel, type ToastChannel, type ToastKind, type ToastMessage } from "./ui/Toast";
import { usePresence } from "./ui/motion";
import { SIDEBAR_WIDTH, drawerLayout as drawerLayoutBucket } from "./ui/breakpoints";
import { useWindowLayout } from "./ui/use-breakpoints";

type ViewMode = "canvas" | "library" | "settings";
type DialogState = (
  | { kind: "prompt"; title: string; value: string; validate?: (value: string) => string | null; resolve: (value: string | null) => void }
  | { kind: "confirm"; title: string; message: string; resolve: (value: boolean) => void }
) & { anchor?: PanelAnchor | null };
type PathSettings = { filePath: string };
type PageOrigin = { kind: "canvas"; canvasId: string } | { kind: "library" };
type PageState = { contentId: string; origin: PageOrigin };
type ActionsState = { context: ContentActionContext; contentIds: string[]; nodeIds: string[]; anchor: PanelAnchor; key: number };
type CreateMenuState = { canvasId: string; x: number; y: number; point: CanvasPoint };

const PATH_SETTINGS_KEY = "quick-image-board.path-settings";
const SIDEBAR_COLLAPSED_KEY = "quick-image-board.sidebar-collapsed";
/** Time the pointer may cross the gap between the toggle and its peek panel. */
const SIDEBAR_PEEK_GRACE_MS = 170;
const HISTORY_OPEN_KEY = "quick-image-board.history-open";
const DEFAULT_PATH_SETTINGS: PathSettings = { filePath: "quick-image-board" };
const FALLBACK_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };
function readPathSettings(): PathSettings {
  try {
    const raw = window.localStorage.getItem(PATH_SETTINGS_KEY);
    const value = raw ? JSON.parse(raw) as Partial<PathSettings> : {};
    return { filePath: typeof value.filePath === "string" ? value.filePath : DEFAULT_PATH_SETTINGS.filePath };
  } catch { return { ...DEFAULT_PATH_SETTINGS }; }
}

function readSidebarPinned(): boolean | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return raw === null ? null : raw !== "1";
  } catch { return null; }
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.isContentEditable || element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .ProseMirror'));
}

/** Static app mark used in the title bar and sidebar footer. */
function AppLogo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1.5" y="1.5" width="25" height="25" rx="7" fill="var(--accent)" />
      <rect x="7.5" y="8" width="13" height="3" rx="1.5" fill="#fff" opacity=".9" />
      <rect x="7.5" y="13" width="13" height="3" rx="1.5" fill="#fff" opacity=".62" />
      <rect x="7.5" y="18" width="8.5" height="3" rx="1.5" fill="#fff" opacity=".35" />
    </svg>
  );
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const [sidebarPinnedChoice, setSidebarPinnedChoice] = useState<boolean | null>(readSidebarPinned);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [settingsSidebarPinned, setSettingsSidebarPinned] = useState(true);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("canvas");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [treeQuery, setTreeQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarSearchFocusPendingRef = useRef(false);
  const [showControls, setShowControls] = useState(true);
  const [canvasTool, setCanvasTool] = useState<CanvasTool>("select");
  const [pathSettings, setPathSettings] = useState<PathSettings>(() => readPathSettings());
  const [canvasAppearance, setCanvasAppearance] = useState<CanvasAppearance>(() => readCanvasAppearance(window.localStorage));
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  selectedNodeIdsRef.current = selectedNodeIds;
  const [selectedContentIds, setSelectedContentIds] = useState<string[]>([]);
  const selectedContentIdsRef = useRef(selectedContentIds);
  selectedContentIdsRef.current = selectedContentIds;
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const selectedCardIdRef = useRef<string | null>(selectedCardId);
  selectedCardIdRef.current = selectedCardId;
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  selectedEdgeIdsRef.current = selectedEdgeIds;
  const [page, setPage] = useState<PageState | null>(null);
  const pageNavigationGuardRef = useRef<(() => boolean | Promise<boolean>) | null>(null);
  const [workspaceToolbarHost, setWorkspaceToolbarHost] = useState<HTMLDivElement | null>(null);
  const pageRef = useRef<PageState | null>(page);
  pageRef.current = page;
  const [pageOpen, setPageOpen] = useState(false);
  const pagePresence = usePresence(pageOpen, 200);
  const pageActionRef = useRef<{ canvasId: string } | null>(null);
  const pageOriginElementRef = useRef<HTMLElement | null>(null);
  const [actions, setActions] = useState<ActionsState | null>(null);
  const actionsRef = useRef<ActionsState | null>(actions);
  actionsRef.current = actions;
  const lastActionsRef = useRef<ActionsState | null>(null);
  if (actions) lastActionsRef.current = actions;
  const shownActions = actions ?? lastActionsRef.current;
  const actionsPresence = usePresence(actions !== null, 140);
  const actionsKeyRef = useRef(0);
  const [cardMenu, setCardMenu] = useState<{ canvasId: string; x: number; y: number } | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const createMenuRef = useRef<CreateMenuState | null>(createMenu);
  createMenuRef.current = createMenu;
  /** Last pointer position, tracked passively so Shift+A never re-renders on move. */
  const pointerClientRef = useRef<{ x: number; y: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(() => window.localStorage.getItem(HISTORY_OPEN_KEY) !== "0");
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null);
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; nonce: number } | null>(null);
  const focusNonceRef = useRef(0);
  const [spawnFrom, setSpawnFrom] = useState<{ point: CanvasPoint; nonce: number } | null>(null);
  const spawnNonceRef = useRef(0);
  const enterMotionRef = useRef<"into" | "out" | "flat">("flat");
  const revealRef = useRef<{ canvasId: string; contentId: string } | null>(null);
  const [zoomDisplay, setZoomDisplay] = useState(FALLBACK_VIEWPORT.zoom);
  const viewportCacheRef = useRef(new Map<string, CanvasViewport>());
  const windowLayout = useWindowLayout();
  // A saved pin choice wins at every width; only an unsaved preference falls
  // back to the wide-window default (pinned at >=1100, collapsed below).
  const sidebarPinned = viewMode === "settings" ? settingsSidebarPinned : sidebarPinnedChoice ?? windowLayout.sidebar === "docked";
  const sidebarVisible = sidebarPinned || sidebarPeek;
  const sidebarVisibleRef = useRef(sidebarVisible);
  sidebarVisibleRef.current = sidebarVisible;
  const sidebarPinnedRef = useRef(sidebarPinned);
  sidebarPinnedRef.current = sidebarPinned;
  const sidebarPeekRef = useRef(sidebarPeek);
  sidebarPeekRef.current = sidebarPeek;
  const sidebarPointerInsideRef = useRef(false);
  const sidebarDraggingRef = useRef(false);
  const sidebarMenuOriginRef = useRef<HTMLElement | null>(null);
  const peekTimerRef = useRef<number | null>(null);
  const toggleSidebarRef = useRef<() => void>(() => {});
  const workspaceMainRef = useRef<HTMLDivElement>(null);
  // Derived from the window width minus the pinned sidebar, never from the
  // observed element: the drawer's own slot width feeds back into
  // workspace-main, which oscillated docked<->overlay on every frame. A hover
  // peek floats over the workspace and therefore claims no width.
  const drawerLayout = drawerLayoutBucket(window.innerWidth - (sidebarPinned ? SIDEBAR_WIDTH : 0));
  const [topbarMenu, setTopbarMenu] = useState<{ x: number; y: number } | null>(null);
  const viewportTimersRef = useRef(new Map<string, number>());
  const gestureBusyRef = useRef(false);
  const pendingPushRef = useRef<AppState | null>(null);
  const stageRef = useRef<CanvasStageHandle | null>(null);
  const titleDragRef = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const titleDragBusy = useRef(false);
  const windowStateSequence = useRef(0);
  const titleDragMove = (event: Pick<PointerEvent, "pointerId" | "buttons" | "clientX" | "clientY">) => {
    const start = titleDragRef.current;
    if (!start || start.pointer !== event.pointerId || !(event.buttons & 1) || titleDragBusy.current) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
    titleDragRef.current = null;
    titleDragBusy.current = true;
    void window.imageBoard.startTitlebarDrag().then(() => refreshMaximized()).catch((caught) => showError(caught instanceof Error ? caught.message : "拖动窗口失败")).finally(() => { titleDragBusy.current = false; });
  };
  const titleDragMoveRef = useRef(titleDragMove); titleDragMoveRef.current = titleDragMove;
  const [maximized, setMaximized] = useState(false);
  const maximizeBusy = useRef(false);
  const refreshMaximized = useCallback(() => {
    const sequence = ++windowStateSequence.current;
    if (typeof window.imageBoard.isMaximized !== "function") return;
    void window.imageBoard.isMaximized().then((value) => {
      if (sequence === windowStateSequence.current) setMaximized(value);
    }).catch(() => { /* A later focus/resize will retry a transient host failure. */ });
  }, []);
  useEffect(() => {
    let frame: number | null = null;
    const refresh = () => { if (frame !== null) cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = null; refreshMaximized(); }); };
    const blur = () => { titleDragRef.current = null; };
    const move = (event: PointerEvent) => titleDragMoveRef.current(event);
    refreshMaximized();
    window.addEventListener("resize", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", blur);
    window.addEventListener("pointerup", blur);
    window.addEventListener("pointercancel", blur);
    window.addEventListener("pointermove", move);
    return () => {
      windowStateSequence.current += 1;
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh); window.removeEventListener("focus", refresh); window.removeEventListener("blur", blur);
      window.removeEventListener("pointerup", blur); window.removeEventListener("pointercancel", blur); window.removeEventListener("pointermove", move);
    };
  }, [refreshMaximized]);
  const startTitlebarPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || titleDragBusy.current || maximizeBusy.current) return;
    if ((event.target as Element).closest("button, input, textarea, select, a, [contenteditable]")) return;
    event.preventDefault();
    titleDragRef.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
  };
  const resizeWindowFromEdge = (event: React.PointerEvent, direction: WindowResizeDirection) => {
    if (event.button !== 0 || maximized || typeof window.imageBoard.startResizeDragging !== "function") return;
    event.preventDefault(); event.stopPropagation(); titleDragRef.current = null;
    void window.imageBoard.startResizeDragging(direction).then(refreshMaximized).catch((caught) => showError(caught instanceof Error ? caught.message : "调整窗口大小失败"));
  };
  const toggleMaximize = async () => {
    if (maximizeBusy.current) return;
    maximizeBusy.current = true;
    try { const next = await window.imageBoard.toggleMaximized(); windowStateSequence.current += 1; setMaximized(next); }
    catch (caught) { showError(caught instanceof Error ? caught.message : "切换窗口大小失败"); }
    finally { maximizeBusy.current = false; }
  };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Synchronous guard: the async create flow may await a URL prompt before `busy` renders. */
  const createNodeBusyRef = useRef(false);
  const copyBusyRef = useRef(false);
  /** Prevents a second delete/remove from racing the 140 ms exit animation. */
  const structureBusyRef = useRef(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastChannelRef = useRef<ToastChannel | null>(null);
  if (!toastChannelRef.current) toastChannelRef.current = toastChannel();
  const [failureLabel, setFailureLabel] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const dialogRef = useRef<DialogState | null>(dialog);
  dialogRef.current = dialog;
  const lastDialogRef = useRef<DialogState | null>(null);
  if (dialog) lastDialogRef.current = dialog;
  const shownDialog = dialog ?? lastDialogRef.current;
  const dialogPresence = usePresence(dialog !== null, 140);
  const appShellRef = useRef<HTMLElement>(null);
  const sidebarContentRef = useRef<HTMLDivElement | null>(null);
  const sidebarKeyboardInputRef = useRef(false);
  const trailCurrentRef = useRef<HTMLButtonElement>(null);
  const historySlotRef = useRef<HTMLDivElement>(null);
  const workspaceViewRef = useRef<HTMLDivElement>(null);
  const changeCanvasRef = useRef<(canvasId: string) => void>(() => {});
  const switchViewRef = useRef<(view: ViewMode) => boolean | Promise<boolean>>(() => true);
  const openPageRef = useRef<(contentId: string, origin: PageOrigin, originElement?: HTMLElement | null) => void>(() => {});

  const activeCanvas = state?.canvases.find((canvas) => canvas.id === state.activeCanvasId) ?? null;
  const activeParentId = activeCanvas?.parentId ?? null;
  const contentCount = state ? Object.keys(state.contents).length : 0;
  const dialogOpen = dialog !== null;
  const breadcrumb = useMemo(() => {
    if (!state) return [] as CanvasRecord[];
    const byId = new Map(state.canvases.map((canvas) => [canvas.id, canvas] as const));
    const chain: CanvasRecord[] = [];
    let current = byId.get(state.activeCanvasId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain;
  }, [state]);
  const pageOriginChain = useMemo(() => {
    if (!state || !page || page.origin.kind !== "canvas") return [] as CanvasRecord[];
    const byId = new Map(state.canvases.map((canvas) => [canvas.id, canvas] as const));
    const chain: CanvasRecord[] = [];
    let current = byId.get(page.origin.canvasId);
    while (current) {
      chain.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain;
  }, [page, state]);
  const pageContent = page && state ? state.contents[page.contentId] : undefined;
  const pageOriginLabel = !page
    ? ""
    : page.origin.kind === "library"
      ? "分类库"
      : pageOriginChain.map((canvas) => canvas.name).join(" / ") || "画布";
  // Content ids of the current canvas selection, in node z-order (deduplicated:
  // one content can be placed more than once).
  const canvasContentIds = useMemo(() => {
    if (!activeCanvas) return [] as string[];
    const selected = new Set(selectedNodeIds);
    const ids: string[] = [];
    for (const node of activeCanvas.nodes) {
      if (selected.has(node.id) && !ids.includes(node.contentId)) ids.push(node.contentId);
    }
    return ids;
  }, [activeCanvas, selectedNodeIds]);
  const canvasContentIdsRef = useRef(canvasContentIds);
  canvasContentIdsRef.current = canvasContentIds;
  const selectableContentIds = viewMode === "canvas" ? canvasContentIds : selectedContentIds;

  // Selection toolbar / canvas toolbar keep their last content mounted through
  // the exit; pointer input is disabled by the motion preset.
  const selectionOpen = !actions && !page
    && (selectedNodeIds.length > 0
      || selectedEdgeIds.length > 0
      || (viewMode === "library" && selectedContentIds.length > 0));
  const selectionSnapshotRef = useRef({ label: "", canGroup: false, canAct: false });
  if (selectionOpen) {
    const label = viewMode === "library"
      ? `已选 ${selectedContentIds.length} 项`
      : [selectedNodeIds.length > 0 ? `${selectedNodeIds.length} 个节点` : "", selectedEdgeIds.length > 0 ? `${selectedEdgeIds.length} 条连线` : ""].filter(Boolean).join(" · ").replace(/^/, "已选 ");
    selectionSnapshotRef.current = {
      label,
      canGroup: viewMode === "canvas" && selectedNodeIds.length > 0,
      canAct: selectableContentIds.length > 0,
    };
  }
  const selectionPresence = usePresence(selectionOpen, 140);
  const canvasToolbarPresence = usePresence(viewMode === "canvas" && !page, 140);

  // ---- single feedback outlet -------------------------------------------------
  const showToast = useCallback((kind: ToastKind, message: string) => {
    setToast(toastChannelRef.current?.next(kind, message) ?? null);
  }, []);
  const clearToast = useCallback(() => setToast(null), []);
  const showError = useCallback((message: string) => {
    setFailureLabel(message);
    setToast(toastChannelRef.current?.next("error", message) ?? null);
  }, []);
  const showNotice = useCallback((message: string) => {
    setFailureLabel("");
    setToast(toastChannelRef.current?.next("success", message) ?? null);
  }, []);
  const showInfo = useCallback((message: string) => {
    setToast(toastChannelRef.current?.next("info", message) ?? null);
  }, []);
  const markBusy = useCallback((label?: string) => {
    setBusyLabel(label ?? "正在处理…");
    setBusy(true);
  }, []);
  const markIdle = useCallback(() => {
    setBusy(false);
    setBusyLabel(null);
  }, []);

  const applyState = useCallback((next: AppState) => {
    // Revision guard: snapshots from either window arrive in any order; drop
    // anything older than the snapshot this window already holds.
    const held = stateRef.current;
    if (held && next.revision < held.revision) return;
    stateRef.current = next;
    setState(next);
    if (next.storageNotice) showToast("warning", next.storageNotice);
  }, [showToast]);

  const update = useCallback(async (operation: () => Promise<AppState>) => {
    try {
      applyState(await operation());
      return true;
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "操作失败");
      return false;
    }
  }, [applyState, showError]);

  const clearSelection = useCallback(() => {
    selectedNodeIdsRef.current = [];
    selectedContentIdsRef.current = [];
    selectedCardIdRef.current = null;
    selectedEdgeIdsRef.current = [];
    setSelectedNodeIds([]);
    setSelectedContentIds([]);
    setSelectedCardId(null);
    setSelectedEdgeIds([]);
  }, []);

  const closeActions = useCallback(() => setActions(null), []);

  // ---- data load --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void window.imageBoard.loadState().then((next) => {
      if (cancelled) return;
      viewportCacheRef.current.clear();
      applyState(next);
    }).catch((caught) => {
      if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "本地数据加载失败");
    });
    return () => { cancelled = true; };
  }, [applyState, loadAttempt]);

  useEffect(() => {
    const api = window.imageBoard;
    if (typeof api.onStateChanged !== "function") return;
    return api.onStateChanged((next) => {
      // Never disturb an in-flight gesture; apply the newest snapshot after it.
      if (gestureBusyRef.current) {
        pendingPushRef.current = next;
        return;
      }
      applyState(next);
    });
  }, [applyState]);

  const handleInteractionChange = useCallback((nextBusy: boolean) => {
    gestureBusyRef.current = nextBusy;
    if (nextBusy) return;
    const pending = pendingPushRef.current;
    pendingPushRef.current = null;
    if (pending) applyState(pending);
  }, [applyState]);

  // Settings drive the drawer's recording state and the Settings page.
  useEffect(() => {
    let active = true;
    void window.imageBoard.getDesktopSettings().then((settings) => {
      if (!active) return;
      setDesktopSettings(settings);
      setCaptureEnabled(settings.captureEnabled !== false);
    }).catch(() => { /* Settings page and ShellSettings surface host errors themselves. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (sidebarPinnedChoice === null) return;
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarPinnedChoice ? "0" : "1"); } catch { /* local preference storage is optional */ }
  }, [sidebarPinnedChoice]);
  useEffect(() => {
    try { window.localStorage.setItem(HISTORY_OPEN_KEY, historyOpen ? "1" : "0"); } catch { /* local preference storage is optional */ }
  }, [historyOpen]);
  useEffect(() => {
    const slot = historySlotRef.current;
    if (!slot) return;
    if (historyOpen && !page) slot.removeAttribute("inert");
    else slot.setAttribute("inert", "");
  }, [historyOpen, viewMode, page]);
  // The full page covers the workspace: keep the underlay out of focus/tab order.
  useEffect(() => {
    const view = workspaceViewRef.current;
    if (!view) return;
    if (page) view.setAttribute("inert", "");
    else view.removeAttribute("inert");
  }, [page]);
  const cancelPeekClose = useCallback(() => {
    if (peekTimerRef.current === null) return;
    window.clearTimeout(peekTimerRef.current);
    peekTimerRef.current = null;
  }, []);
  const closePeek = useCallback(() => {
    cancelPeekClose();
    sidebarMenuOriginRef.current = null;
    sidebarSearchFocusPendingRef.current = false;
    setSidebarPeek(false);
  }, [cancelPeekClose]);
  const openPeek = useCallback(() => {
    if (sidebarPinnedRef.current) return;
    cancelPeekClose();
    setSidebarPeek(true);
  }, [cancelPeekClose]);
  const focusSidebarToggle = useCallback(() => {
    document.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus({ preventScroll: true });
  }, []);
  const dismissSidebar = useCallback(() => {
    cancelPeekClose();
    sidebarPointerInsideRef.current = false;
    sidebarMenuOriginRef.current = null;
    sidebarSearchFocusPendingRef.current = false;
    setSidebarPeek(false);
    if (viewModeRef.current === 'settings') setSettingsSidebarPinned(false);
    else setSidebarPinnedChoice(false);
    stageRef.current?.beginWindowAnchoredResize();
    focusSidebarToggle();
  }, [cancelPeekClose, focusSidebarToggle]);
  /** Keyboard focus — or a focused search field — holds the peek open. */
  const peekHeldByKeyboard = useCallback(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest(".sidebar")) return false;
    return sidebarKeyboardInputRef.current || active === searchInputRef.current;
  }, []);
  const peekHeldByInteraction = useCallback(() => sidebarDraggingRef.current || Boolean(sidebarMenuOriginRef.current && (
    document.querySelector('.canvas-context-menu:not([data-motion="exit"])') || dialogRef.current
  )), []);
  /** One grace period bridges the trigger/panel gap and protects ongoing work. */
  const schedulePeekClose = useCallback(() => {
    if (sidebarPinnedRef.current || sidebarPointerInsideRef.current) return;
    cancelPeekClose();
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      if (!sidebarPinnedRef.current && !sidebarPointerInsideRef.current && !peekHeldByKeyboard() && !peekHeldByInteraction()) setSidebarPeek(false);
    }, SIDEBAR_PEEK_GRACE_MS);
  }, [cancelPeekClose, peekHeldByKeyboard, peekHeldByInteraction]);
  useEffect(() => {
    if (!sidebarPeek) return;
    const finishDrag = (event: DragEvent) => {
      if (!sidebarDraggingRef.current) return;
      sidebarDraggingRef.current = false;
      const hit = document.elementFromPoint?.(event.clientX, event.clientY);
      sidebarPointerInsideRef.current = Boolean(hit?.closest('.sidebar, .sidebar-toggle'));
      schedulePeekClose();
    };
    const observer = new MutationObserver(() => {
      const origin = sidebarMenuOriginRef.current;
      if (!origin || !sidebarPeekRef.current) return;
      if (peekHeldByInteraction()) { cancelPeekClose(); return; }
      sidebarMenuOriginRef.current = null;
      const active = document.activeElement;
      if (sidebarKeyboardInputRef.current && origin.isConnected && (active === document.body || active instanceof Element && active.closest('.canvas-context-menu, .dialog-card'))) {
        origin.tabIndex = -1; origin.focus({ preventScroll: true });
      }
      schedulePeekClose();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-motion'] });
    document.addEventListener('dragend', finishDrag, true);
    document.addEventListener('drop', finishDrag, true);
    return () => { observer.disconnect(); document.removeEventListener('dragend', finishDrag, true); document.removeEventListener('drop', finishDrag, true); };
  }, [cancelPeekClose, peekHeldByInteraction, schedulePeekClose, sidebarPeek]);
  useEffect(() => {
    const trackPointer = (event: PointerEvent) => {
      pointerClientRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", trackPointer, { passive: true });
    return () => window.removeEventListener("pointermove", trackPointer);
  }, []);
  useEffect(() => {
    const markKeyboard = () => { sidebarKeyboardInputRef.current = true; };
    const markPointer = () => { sidebarKeyboardInputRef.current = false; };
    document.addEventListener("keydown", markKeyboard, true);
    document.addEventListener("pointerdown", markPointer, true);
    return () => {
      document.removeEventListener("keydown", markKeyboard, true);
      document.removeEventListener("pointerdown", markPointer, true);
    };
  }, []);
  // A closed sidebar is out of the tab order even before its fade finishes,
  // including on the first mount while the data snapshot is still loading.
  const attachSidebarContent = useCallback((node: HTMLDivElement | null) => {
    sidebarContentRef.current = node;
    if (!node) return;
    if (sidebarVisibleRef.current) node.removeAttribute("inert");
    else node.setAttribute("inert", "");
  }, []);
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) return;
    if (sidebarVisible) content.removeAttribute("inert");
    else content.setAttribute("inert", "");
    // Fulfil shortcuts after React commits the visible, non-inert panel. This
    // also covers shortcuts requested while the initial snapshot is loading.
    if (!sidebarVisible || !sidebarSearchFocusPendingRef.current) return;
    let frame: number | null = null;
    const focusCommittedSearch = () => {
      const input = searchInputRef.current;
      if (!sidebarVisibleRef.current || !sidebarSearchFocusPendingRef.current || !input) return;
      input.focus({ preventScroll: true });
      if (document.activeElement === input) sidebarSearchFocusPendingRef.current = false;
      // Visibility inherited through transitioning descendants may settle over
      // several frames. Keep the request until focus succeeds or is cancelled.
      else frame = requestAnimationFrame(focusCommittedSearch);
    };
    focusCommittedSearch();
    return () => { if (frame !== null) cancelAnimationFrame(frame); };
  }, [sidebarVisible, state !== null]);
  useEffect(() => {
    const onWindowBlur = () => {
      if (!sidebarPinnedRef.current) closePeek();
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [closePeek]);
  // The peek floats above a mounted full page. Capture Escape at the window
  // (before any page mounts its own listener) so only the peek dismisses;
  // dialogs, actions and portalled menus keep Escape first.
  useEffect(() => {
    const onPeekEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (!sidebarPeekRef.current || sidebarPinnedRef.current) return;
      if (dialogRef.current || actionsRef.current || gestureBusyRef.current) return;
      if (isEditableTarget(event.target)) return;
      if (document.querySelector('[data-esc-layer]:not([data-motion="exit"]), .dialog-card:not([data-motion="exit"]), .content-actions:not([data-motion="exit"]), .canvas-context-menu:not([data-motion="exit"])')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePeek(); focusSidebarToggle();
    };
    window.addEventListener("keydown", onPeekEscape, true);
    return () => window.removeEventListener("keydown", onPeekEscape, true);
  }, [closePeek, focusSidebarToggle]);
  useEffect(() => () => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
  }, []);
  // Deep chains scroll horizontally; keep the active tab reachable.
  useLayoutEffect(() => {
    const trail = trailCurrentRef.current?.closest(".canvas-trail");
    if (!trail) return;
    const revealCurrent = () => trailCurrentRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    revealCurrent();
    const resizeObserver = new ResizeObserver(revealCurrent);
    resizeObserver.observe(trail);
    const contentObserver = new MutationObserver(revealCurrent);
    contentObserver.observe(trail, { childList: true, subtree: true, characterData: true });
    return () => {
      resizeObserver.disconnect();
      contentObserver.disconnect();
    };
  }, [state?.activeCanvasId, viewMode, page]);
  const toggleSidebar = useCallback(() => {
    cancelPeekClose();
    if (sidebarPinnedRef.current) {
      dismissSidebar();
    } else {
      if (viewModeRef.current === 'settings') setSettingsSidebarPinned(true);
      else setSidebarPinnedChoice(true);
      setSidebarPeek(false);
      stageRef.current?.beginWindowAnchoredResize();
    }
  }, [cancelPeekClose, dismissSidebar]);
  toggleSidebarRef.current = toggleSidebar;
  // The floating peek has no scrim: any press outside the panel, its toggle or
  // a portalled tree menu dismisses it. A pinned sidebar never closes this way.
  useEffect(() => {
    if (sidebarPinned || !sidebarPeek) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!peekHeldByInteraction() && !target?.closest(".sidebar, .sidebar-toggle, .canvas-context-menu")) closePeek();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [closePeek, peekHeldByInteraction, sidebarPeek, sidebarPinned]);
  useEffect(() => {
    try { window.localStorage.setItem(PATH_SETTINGS_KEY, JSON.stringify(pathSettings)); } catch { /* local preference storage is optional */ }
  }, [pathSettings]);
  useEffect(() => saveCanvasAppearance(window.localStorage, canvasAppearance), [canvasAppearance]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      sidebarSearchFocusPendingRef.current = true;
      openPeek();
      if (sidebarVisibleRef.current && searchInputRef.current) {
        searchInputRef.current.focus({ preventScroll: true });
        if (document.activeElement === searchInputRef.current) sidebarSearchFocusPendingRef.current = false;
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [openPeek]);

  // Keep the zoom readout in sync with the live canvas viewport cache.
  useEffect(() => {
    const id = state?.activeCanvasId;
    if (!id) return;
    const viewport = viewportCacheRef.current.get(id) ?? state.canvases.find((canvas) => canvas.id === id)?.viewport;
    setZoomDisplay(viewport?.zoom ?? FALLBACK_VIEWPORT.zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.activeCanvasId]);

  // One-shot directional transition: later mounts (host-driven switches) stay flat.
  useEffect(() => {
    const timer = window.setTimeout(() => { enterMotionRef.current = "flat"; }, 360);
    return () => window.clearTimeout(timer);
  }, [state?.activeCanvasId]);

  // Resize/zoom guard: WebView2 can momentarily hand the page a stale inner
  // size when the host writes the Run key and the window regains focus; force
  // one layout reflow pass after any inner-size change so the shell can never
  // stay shifted with a white band at the bottom.
  useEffect(() => {
    const reflow = () => { requestAnimationFrame(() => requestAnimationFrame(() => { window.dispatchEvent(new Event('qib:reflow')); })); };
    window.addEventListener('resize', reflow);
    const observer = new ResizeObserver(reflow);
    const root = document.getElementById('root');
    if (root) observer.observe(root);
    return () => { window.removeEventListener('resize', reflow); observer.disconnect(); };
  }, []);

  // ---- viewport persistence ---------------------------------------------------
  useEffect(() => {
    const timers = viewportTimersRef.current;
    return () => { for (const timer of timers.values()) window.clearTimeout(timer); timers.clear(); };
  }, []);

  const persistViewport = useCallback((canvasId: string, viewport: CanvasViewport) => {
    viewportCacheRef.current.set(canvasId, viewport);
    const timers = viewportTimersRef.current;
    const existing = timers.get(canvasId);
    window.clearTimeout(existing);
    timers.set(canvasId, window.setTimeout(() => {
      timers.delete(canvasId);
      const latest = viewportCacheRef.current.get(canvasId) ?? viewport;
      void window.imageBoard.setCanvasViewport(canvasId, latest).catch((caught) => showError(caught instanceof Error ? caught.message : "视角保存失败"));
    }, 180));
  }, [showError]);

  const importViewport = useCallback((): ImportViewport => {
    const live = stageRef.current?.importViewport();
    if (live) return live;
    const current = stateRef.current;
    const canvasId = current?.activeCanvasId;
    const base = (canvasId ? viewportCacheRef.current.get(canvasId) : undefined)
      ?? current?.canvases.find((canvas) => canvas.id === canvasId)?.viewport
      ?? FALLBACK_VIEWPORT;
    return { x: base.x, y: base.y, zoom: base.zoom, width: 720, height: 520 };
  }, []);

  // ---- selection -------------------------------------------------------------
  const selectNode = useCallback((nodeId: string, toggle: boolean) => {
    setSelectedCardId(null);
    if (!toggle) setSelectedEdgeIds([]);
    setSelectedNodeIds((current) => applySelection(current, nodeId, toggle));
  }, []);
  const selectNodes = useCallback((nodeIds: string[], additive: boolean) => {
    setSelectedCardId(null);
    if (!additive) setSelectedEdgeIds([]);
    setSelectedNodeIds((current) => mergeSelection(current, nodeIds, additive));
  }, []);
  const selectCard = useCallback((canvasId: string | null) => {
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setSelectedCardId(canvasId);
  }, []);
  const selectEdge = useCallback((edgeId: string, toggle: boolean) => {
    setSelectedCardId(null);
    setSelectedEdgeIds((current) => applySelection(current, edgeId, toggle));
  }, []);

  // ---- full page --------------------------------------------------------------
  /** Drop the page immediately (view/canvas navigation) without an exit. */
  const dismissPage = useCallback(() => {
    pageActionRef.current = null;
    pageOriginElementRef.current = null;
    revealRef.current = null;
    setPageOpen(false);
    setPage(null);
  }, []);

  /** Normal close: the overlay stays mounted (and fades) before it unmounts. */
  const closePage = useCallback(() => {
    if (!pageRef.current) return;
    pageActionRef.current = null;
    setPageOpen(false);
  }, []);

  const requestPageClose = useCallback(async () => {
    if (await pageNavigationGuardRef.current?.() !== false) closePage();
  }, [closePage]);

  const openPage = useCallback((contentId: string, origin: PageOrigin, originElement?: HTMLElement | null) => {
    const current = stateRef.current;
    if (!current?.contents[contentId]) return;
    pageOriginElementRef.current = originElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setActions(null);
    setCardMenu(null);
    setEdgeMenu(null);
    setCreateMenu(null);
    setPage({ contentId, origin });
    setPageOpen(true);
  }, []);

  const openCanvasFromPage = useCallback((canvasId: string, contentId: string) => {
    if (!pageRef.current) return;
    revealRef.current = { canvasId, contentId };
    pageActionRef.current = { canvasId };
    pageOriginElementRef.current = null;
    setPageOpen(false);
  }, []);

  // The exit has finished: drop the page, apply its deferred navigation, focus.
  useEffect(() => {
    if (pageOpen || pagePresence.mounted || !pageRef.current) return;
    const closing = pageRef.current;
    pageRef.current = null;
    setPage(null);
    setPageOpen(false);
    const action = pageActionRef.current;
    pageActionRef.current = null;
    if (closing.origin.kind === "library") setViewMode("library");
    if (action) {
      setViewMode("canvas");
      if (stateRef.current?.activeCanvasId !== action.canvasId) void changeCanvasRef.current(action.canvasId);
    } else if (closing.origin.kind === "canvas" && stateRef.current?.activeCanvasId !== closing.origin.canvasId) {
      void changeCanvasRef.current(closing.origin.canvasId);
    }
    const origin = pageOriginElementRef.current;
    pageOriginElementRef.current = null;
    requestAnimationFrame(() => {
      const target = origin?.isConnected ? origin : document.querySelector<HTMLElement>(".canvas-node.selected, .lib-card.selected");
      target?.focus();
    });
  }, [page, pageOpen, pagePresence.mounted]);

  useEffect(() => {
    const reveal = revealRef.current;
    const current = state;
    if (!reveal || !current || page || viewMode !== "canvas" || current.activeCanvasId !== reveal.canvasId) return;
    revealRef.current = null;
    const node = current.canvases.find((canvas) => canvas.id === reveal.canvasId)?.nodes.find((item) => item.contentId === reveal.contentId);
    if (!node) return;
    selectedNodeIdsRef.current = [node.id];
    setSelectedNodeIds([node.id]);
    setSelectedCardId(null);
    setSelectedEdgeIds([]);
    setFocusRequest({ nodeId: node.id, nonce: ++focusNonceRef.current });
  }, [state, page, viewMode]);

  // ---- actions menu -----------------------------------------------------------
  const anchorAt = (clientX: number, clientY: number): PanelAnchor => {
    const shell = appShellRef.current?.getBoundingClientRect();
    if (!shell) return { left: 12, top: 12 };
    return {
      left: Math.round(Math.max(12, Math.min(clientX - shell.left + 8, shell.width - 252))),
      top: Math.round(Math.max(12, Math.min(clientY - shell.top + 8, shell.height - 288))),
    };
  };

  const anchorForElement = (element: HTMLElement | null, estimatedHeight = 280): PanelAnchor => {
    const shell = appShellRef.current?.getBoundingClientRect();
    if (!shell) return { left: 12, top: 12 };
    const width = 244;
    const rect = element?.getBoundingClientRect();
    if (!rect) return { left: Math.round((shell.width - width) / 2), top: Math.round(Math.max(12, shell.height / 2 - estimatedHeight / 2)) };
    const rightFits = rect.right - shell.left + 10 + width <= shell.width - 12;
    const leftFits = rect.left - shell.left - 10 - width >= 12;
    const left = rightFits ? rect.right - shell.left + 10 : leftFits ? rect.left - shell.left - 10 - width : (shell.width - width) / 2;
    const top = rightFits || leftFits ? rect.top - shell.top : rect.bottom - shell.top + 10;
    return {
      left: Math.round(Math.max(12, Math.min(left, shell.width - width - 12))),
      top: Math.round(Math.max(12, Math.min(top, shell.height - estimatedHeight - 12))),
    };
  };

  const openContentActions = useCallback((context: ContentActionContext, contentIds: string[], nodeIds: string[], anchor: PanelAnchor) => {
    const ids = [...new Set(contentIds)];
    if (ids.length === 0) return;
    setActions({ context, contentIds: ids, nodeIds, anchor, key: ++actionsKeyRef.current });
    setCardMenu(null);
    setEdgeMenu(null);
    setCreateMenu(null);
  }, []);

  const openNodeActions = useCallback((event: React.MouseEvent<HTMLElement> | null, nodeId: string) => {
    const current = stateRef.current;
    const canvas = current?.canvases.find((item) => item.id === current.activeCanvasId);
    const node = canvas?.nodes.find((item) => item.id === nodeId);
    if (!current || !canvas || !node) return;
    const baseIds = selectedNodeIdsRef.current.includes(nodeId) ? selectedNodeIdsRef.current : [nodeId];
    if (!selectedNodeIdsRef.current.includes(nodeId)) {
      selectedNodeIdsRef.current = [nodeId];
      setSelectedNodeIds([nodeId]);
    }
    setSelectedCardId(null);
    selectedEdgeIdsRef.current = [];
    setSelectedEdgeIds([]);
    const contentIds = canvas.nodes.filter((item) => baseIds.includes(item.id)).map((item) => item.contentId);
    const origin = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openContentActions("canvas", contentIds, baseIds.filter((id) => canvas.nodes.some((item) => item.id === id)), event ? anchorAt(event.clientX, event.clientY) : anchorForElement(origin));
  }, [openContentActions]);

  const openLibraryActions = useCallback((event: React.MouseEvent<HTMLElement> | null, contentId: string) => {
    const selected = selectedContentIdsRef.current;
    const ids = selected.includes(contentId) ? selected : [contentId];
    if (!selected.includes(contentId)) {
      selectedContentIdsRef.current = [contentId];
      setSelectedContentIds([contentId]);
    }
    const origin = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openContentActions("library", ids, [], event ? anchorAt(event.clientX, event.clientY) : anchorForElement(origin));
  }, [openContentActions]);

  const openHistoryActions = useCallback((event: React.MouseEvent<HTMLElement>, contentId: string) => {
    openContentActions("history", [contentId], [], anchorAt(event.clientX, event.clientY));
  }, [openContentActions]);

  const openToolbarActions = useCallback(() => {
    const anchor = anchorForElement(document.querySelector<HTMLElement>(".selection-toolbar"));
    openContentActions(viewModeRef.current === "library" ? "library" : "canvas", viewModeRef.current === "library" ? selectedContentIdsRef.current : canvasContentIdsRef.current, viewModeRef.current === "library" ? [] : selectedNodeIdsRef.current, anchor);
  }, [openContentActions]);

  // ---- dialogs ---------------------------------------------------------------
  const openPrompt = (title: string, value = "", validate?: (value: string) => string | null) => new Promise<string | null>((resolve) => setDialog({ kind: "prompt", title, value, validate, resolve, anchor: null }));
  const openConfirm = (title: string, message: string) => new Promise<boolean>((resolve) => setDialog({ kind: "confirm", title, message, resolve }));
  const clearDialog = useCallback(() => setDialog(null), []);

  // ---- content operations -----------------------------------------------------
  const copyContents = useCallback(async (contentIds: string[]) => {
    const ids = [...new Set(contentIds)].filter((id) => Boolean(stateRef.current?.contents[id]));
    if (ids.length === 0) { showInfo("没有可复制的内容"); return; }
    if (copyBusyRef.current) return;
    copyBusyRef.current = true;
    try {
      const result = await window.imageBoard.copyContents(ids);
      if (result.copied > 0) showNotice("已复制");
      else showInfo("没有复制内容");
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "复制失败");
    } finally {
      copyBusyRef.current = false;
    }
  }, [showError, showInfo, showNotice]);

  const removeNodes = useCallback(async (nodeIds: string[]) => {
    if (nodeIds.length === 0 || !stateRef.current || structureBusyRef.current) return;
    structureBusyRef.current = true;
    try {
      await stageRef.current?.playExit({ nodeIds });
      markBusy("正在移除…");
      try {
        applyState(await window.imageBoard.removeNodes(nodeIds));
        setSelectedNodeIds((current) => current.filter((id) => !nodeIds.includes(id)));
        showNotice("已从画布移除，内容仍在剪贴板历史");
      } catch (caught) {
        showError(caught instanceof Error ? caught.message : "移除失败");
      } finally {
        markIdle();
      }
    } finally {
      structureBusyRef.current = false;
    }
  }, [applyState, markBusy, markIdle, showError, showNotice]);

  const deleteEdges = useCallback(async (edgeIds: string[]) => {
    if (edgeIds.length === 0 || structureBusyRef.current) return;
    structureBusyRef.current = true;
    try {
      await stageRef.current?.playExit({ edgeIds });
      try {
        applyState(await window.imageBoard.deleteEdges(edgeIds));
        setSelectedEdgeIds((current) => current.filter((id) => !edgeIds.includes(id)));
        showNotice("已删除连线");
      } catch (caught) {
        showError(caught instanceof Error ? caught.message : "删除连线失败");
      }
    } finally {
      structureBusyRef.current = false;
    }
  }, [applyState, showError, showNotice]);

  const deleteCanvasSelection = useCallback(async () => {
    const nodeIds = selectedNodeIdsRef.current;
    const edgeIds = selectedEdgeIdsRef.current;
    if (nodeIds.length === 0 && edgeIds.length === 0 || structureBusyRef.current) return;
    structureBusyRef.current = true;
    try {
      await stageRef.current?.playExit({ nodeIds, edgeIds });
      markBusy("正在删除…");
      try {
        let next = stateRef.current;
        if (edgeIds.length > 0) next = await window.imageBoard.deleteEdges(edgeIds);
        if (nodeIds.length > 0) next = await window.imageBoard.removeNodes(nodeIds);
        if (next) applyState(next);
        setSelectedNodeIds([]);
        setSelectedEdgeIds([]);
        if (nodeIds.length > 0) showNotice("已从画布移除，内容仍在剪贴板历史");
        else showNotice("已删除连线");
      } catch (caught) {
        showError(caught instanceof Error ? caught.message : "删除失败");
      } finally {
        markIdle();
      }
    } finally {
      structureBusyRef.current = false;
    }
  }, [applyState, markBusy, markIdle, showError, showNotice]);

  const renameContent = useCallback(async (content: ContentRecord) => {
    const name = await openPrompt("重命名图片", content.image?.fileName ?? content.preview);
    if (name === null || name.trim() === "") return;
    markBusy("正在重命名…");
    try {
      applyState(await window.imageBoard.renameImage(content.id, name.trim()));
      showNotice("图片已重命名");
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "重命名失败");
    } finally {
      markIdle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, markBusy, markIdle, showError, showNotice]);

  const requestDeleteContents = useCallback(async (contentIds: string[]) => {
    const ids = [...new Set(contentIds)];
    if (ids.length === 0) return;
    const canvasesWithContent = new Set<string>();
    for (const canvas of stateRef.current?.canvases ?? []) {
      for (const node of canvas.nodes) if (ids.includes(node.contentId)) canvasesWithContent.add(canvas.id);
    }
    const count = canvasesWithContent.size;
    const message = count > 0
      ? `删除后将从 ${count} 个画布中移除，且无法从剪贴板历史找回。`
      : "删除后无法从剪贴板历史找回。";
    const confirmed = await openConfirm("删除内容？", message);
    if (!confirmed) return;
    const current = stateRef.current;
    const active = current?.canvases.find((canvas) => canvas.id === current.activeCanvasId);
    const visibleNodeIds = active?.nodes.filter((node) => ids.includes(node.contentId)).map((node) => node.id) ?? [];
    await stageRef.current?.playExit({ nodeIds: visibleNodeIds });
    markBusy("正在删除内容…");
    try {
      applyState(await window.imageBoard.deleteContents(ids));
      setSelectedContentIds((current) => current.filter((id) => !ids.includes(id)));
      setSelectedNodeIds([]);
      setSelectedEdgeIds([]);
      showNotice(`已删除 ${ids.length} 项内容`);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "删除内容失败");
    } finally {
      markIdle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, markBusy, markIdle, showError, showNotice]);

  const toggleCapture = useCallback(async (next: boolean) => {
    setCaptureEnabled(next);
    try {
      const settings = await window.imageBoard.setDesktopSettings({ captureEnabled: next });
      setDesktopSettings(settings);
      setCaptureEnabled(settings.captureEnabled !== false);
      showNotice(next ? "已恢复记录剪贴板" : "已暂停记录剪贴板");
    } catch (caught) {
      setCaptureEnabled(!next);
      showError(caught instanceof Error ? caught.message : "保存剪贴板设置失败");
    }
  }, [showError, showNotice]);

  const saveDesktopSettings = useCallback(async (patch: DesktopSettingsPatch) => {
    try {
      const settings = await window.imageBoard.setDesktopSettings(patch);
      setDesktopSettings(settings);
      setCaptureEnabled(settings.captureEnabled !== false);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "保存设置失败");
    }
  }, [showError]);

  const snapToGrid = desktopSettings?.snapToGrid ?? false;
  const toggleSnap = useCallback(() => {
    const next = !snapToGrid;
    setDesktopSettings((current) => (current ? { ...current, snapToGrid: next } : current));
    void window.imageBoard.setDesktopSettings({ snapToGrid: next })
      .then((settings) => setDesktopSettings(settings))
      .catch((caught) => {
        setDesktopSettings((current) => (current ? { ...current, snapToGrid: !next } : current));
        showError(caught instanceof Error ? caught.message : "保存网格对齐设置失败");
      });
  }, [showError, snapToGrid]);

  // ---- canvas operations ------------------------------------------------------
  const groupSelectionIntoCanvas = useCallback(async (nodeIds: string[]) => {
    if (nodeIds.length === 0 || busyRef.current) return;
    const count = nodeIds.length;
    await stageRef.current?.playExit({ nodeIds });
    markBusy("正在创建子画布…");
    try {
      applyState(await window.imageBoard.groupNodesIntoCanvas(nodeIds));
      clearSelection();
      showNotice(`已把 ${count} 个节点组成子画布`);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "创建子画布失败");
    } finally {
      markIdle();
    }
  }, [applyState, clearSelection, markBusy, markIdle, showError, showNotice]);

  const moveNodes = useCallback(async (positions: Array<{ id: string; x: number; y: number }>) => {
    if (positions.length === 0) return;
    try {
      applyState(await window.imageBoard.moveNodes(positions.map((position) => ({ nodeId: position.id, x: position.x, y: position.y }))));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "移动节点失败");
    }
  }, [applyState, showError]);

  const moveNodesIntoCard = useCallback(async (nodeIds: string[], cardId: string) => {
    const card = stateRef.current?.canvases.find((canvas) => canvas.id === cardId);
    if (!card?.frame) return;
    const origin = { x: card.frame.x, y: card.frame.y };
    const count = nodeIds.length;
    await stageRef.current?.playExit({ nodeIds });
    markBusy("正在移入子画布…");
    try {
      applyState(await window.imageBoard.moveNodesToCanvas(nodeIds, cardId, origin));
      setSelectedNodeIds([]);
      showNotice(`已把 ${count} 个节点移入「${card.name}」`);
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "移入子画布失败");
    } finally {
      markIdle();
    }
  }, [applyState, markBusy, markIdle, showError, showNotice]);

  const moveCard = useCallback((canvasId: string, frame: CanvasFrame) => {
    void update(() => window.imageBoard.setCanvasFrame(canvasId, frame));
  }, [update]);

  const createEdge = useCallback(async (fromNodeId: string, toNodeId: string) => {
    try {
      applyState(await window.imageBoard.createEdge(fromNodeId, toNodeId));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "创建连线失败");
    }
  }, [applyState, showError]);

  const deleteCanvas = useCallback(async (canvasId: string) => {
    const canvas = stateRef.current?.canvases.find((item) => item.id === canvasId);
    if (!canvas) return;
    const confirmed = await openConfirm("删除画布？", `删除「${canvas.name}」及其全部子画布？其中的内容会回到剪贴板历史，不会被删除。`);
    if (!confirmed) return;
    await stageRef.current?.playExit({ cardIds: [canvasId] });
    clearSelection();
    await update(() => window.imageBoard.deleteCanvas(canvasId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSelection, update]);

  const renameCanvasById = useCallback(async (canvasId: string) => {
    const canvas = stateRef.current?.canvases.find((item) => item.id === canvasId);
    if (!canvas) return;
    const name = await openPrompt("重命名画布", canvas.name);
    if (name !== null && name.trim() !== "") void update(() => window.imageBoard.renameCanvas(canvasId, name.trim()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  const changeCanvas = useCallback(async (canvasId: string) => {
    const current = stateRef.current;
    if (!current || busyRef.current) return;
    if (pageRef.current && await pageNavigationGuardRef.current?.() === false) return;
    if (pageRef.current) dismissPage();
    if (canvasId === current.activeCanvasId) return;
    const isAncestor = (ancestorId: string, descendantId: string) => {
      const byId = new Map(current.canvases.map((canvas) => [canvas.id, canvas] as const));
      let cursor = byId.get(descendantId);
      while (cursor) {
        if (cursor.id === ancestorId) return true;
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      return false;
    };
    enterMotionRef.current = isAncestor(current.activeCanvasId, canvasId)
      ? "into"
      : isAncestor(canvasId, current.activeCanvasId) ? "out" : "flat";
    // The surface unmounts here; a deferred push from the old gesture must not
    // overwrite the switch result.
    gestureBusyRef.current = false;
    pendingPushRef.current = null;
    setCreateMenu(null);
    clearSelection();
    markBusy();
    try {
      applyState(await window.imageBoard.setActiveCanvas(canvasId));
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : "切换画布失败");
    } finally {
      markIdle();
    }
  }, [applyState, clearSelection, dismissPage, markBusy, markIdle, showError]);
  changeCanvasRef.current = (canvasId) => void changeCanvas(canvasId);

  const moveCanvasNode = useCallback((canvasId: string, parentId: string | null, index: number | null) => {
    const current = stateRef.current;
    if (!current) return;
    const byId = new Map(current.canvases.map((canvas) => [canvas.id, canvas] as const));
    let cursor = parentId ? byId.get(parentId) : undefined;
    while (cursor) {
      if (cursor.id === canvasId) { showError("不能把画布移入它自己的子画布"); return; }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    clearSelection();
    void update(() => window.imageBoard.moveCanvas(canvasId, parentId, index ?? undefined));
  }, [clearSelection, update, showError]);

  const ungroupCanvasById = useCallback((canvasId: string) => {
    clearSelection();
    void update(() => window.imageBoard.ungroupCanvas(canvasId));
  }, [clearSelection, update]);

  const switchView = useCallback(async (next: ViewMode) => {
    if (pageRef.current && await pageNavigationGuardRef.current?.() === false) return false;
    gestureBusyRef.current = false;
    pendingPushRef.current = null;
    dismissPage();
    if (next === "settings" && viewModeRef.current !== "settings") setSettingsSidebarPinned(true);
    setSidebarPeek(false);
    setViewMode(next);
    clearSelection();
    setActions(null);
    setCardMenu(null);
    setEdgeMenu(null);
    setCreateMenu(null);
    return true;
  }, [clearSelection, dismissPage]);
  switchViewRef.current = switchView;
  openPageRef.current = openPage;

  // ---- history drawer --------------------------------------------------------
  const dropHistoryContent = useCallback((contentId: string, clientX: number, clientY: number): boolean => {
    const stage = stageRef.current;
    const current = stateRef.current;
    if (!stage || !current) return false;
    if (!stage.containsClient(clientX, clientY)) return false;
    const point = stage.worldPoint(clientX, clientY);
    if (!point) return false;
    const canvasId = current.activeCanvasId;
    void window.imageBoard.placeContent(contentId, canvasId, point).then((next) => {
      spawnNonceRef.current += 1;
      setSpawnFrom({ point, nonce: spawnNonceRef.current });
      applyState(next);
      const node = next.canvases.find((canvas) => canvas.id === canvasId)?.nodes.filter((item) => item.contentId === contentId).pop();
      if (!node) return;
      selectedNodeIdsRef.current = [node.id];
      setSelectedNodeIds([node.id]);
      setSelectedCardId(null);
      setSelectedEdgeIds([]);
      showNotice("已放到画布");
    }).catch((caught) => showError(caught instanceof Error ? caught.message : "放到画布失败"));
    return true;
  }, [applyState, showError, showNotice]);

  // ---- new nodes from blank canvas ------------------------------------------
  const openCreateMenu = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const current = stateRef.current;
    if (!stage || !current?.activeCanvasId) return;
    if (busyRef.current || createNodeBusyRef.current || pageRef.current || dialogRef.current) return;
    // A fading dialog/page drops pointer events; never create through its exit.
    if (document.querySelector(".dialog-card, .page-layer")) return;
    if (!stage.containsClient(clientX, clientY)) return;
    const point = stage.worldPoint(clientX, clientY);
    if (!point) return;
    setCardMenu(null);
    setEdgeMenu(null);
    setTopbarMenu(null);
    setActions(null);
    setCreateMenu({ canvasId: current.activeCanvasId, x: clientX, y: clientY, point });
  }, []);

  /** Shift+A: use the live pointer only while it is over the canvas, else the viewport center. */
  const openCreateMenuFromKeyboard = useCallback(() => {
    const stage = stageRef.current;
    const current = stateRef.current;
    if (!stage || !current?.activeCanvasId) return;
    const viewport = document.querySelector<HTMLElement>(".canvas-viewport");
    const rect = viewport?.getBoundingClientRect();
    if (!rect) return;
    const pointer = pointerClientRef.current;
    const pointClient = pointer && stage.containsClient(pointer.x, pointer.y) ? pointer : null;
    openCreateMenu(
      pointClient ? pointClient.x : rect.left + rect.width / 2,
      pointClient ? pointClient.y : rect.top + rect.height / 2,
    );
  }, [openCreateMenu]);

  const createNodeFromMenu = useCallback(async (kind: NewContentInput["kind"], target: CreateMenuState) => {
    if (busyRef.current || createNodeBusyRef.current) return;
    createNodeBusyRef.current = true;
    try {
      let input: NewContentInput;
      if (kind === "link") {
        const value = await openPrompt("新建链接节点", "https://", (candidate) => isHttpUrl(candidate) ? null : "请输入完整的 http(s) 链接");
        if (value === null) return;
        const url = value.trim();
        if (!isHttpUrl(url)) return;
        input = { kind: "link", url };
      } else {
        input = { kind: "richText" };
      }
      markBusy("正在新建节点…");
      try {
        const result = await window.imageBoard.createContentNode(target.canvasId, target.point, input);
        spawnNonceRef.current += 1;
        setSpawnFrom({ point: target.point, nonce: spawnNonceRef.current });
        applyState(result.state);
        selectedNodeIdsRef.current = [result.nodeId];
        setSelectedNodeIds([result.nodeId]);
        selectedCardIdRef.current = null;
        setSelectedCardId(null);
        selectedEdgeIdsRef.current = [];
        setSelectedEdgeIds([]);
        openPage(result.contentId, { kind: "canvas", canvasId: target.canvasId }, null);
        showNotice("已新建节点");
      } catch (caught) {
        showError(caught instanceof Error ? caught.message : "新建节点失败");
      } finally {
        markIdle();
      }
    } finally {
      createNodeBusyRef.current = false;
    }
    // openPrompt is intentionally not a dependency: it only opens the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, markBusy, markIdle, openPage, showError, showNotice]);

  /** Dock actions always use the visible board center, not the toolbar's pointer position. */
  const dockCreateTarget = useCallback((): CreateMenuState | null => {
    const canvasId = stateRef.current?.activeCanvasId;
    const rect = document.querySelector<HTMLElement>(".canvas-viewport")?.getBoundingClientRect();
    if (!canvasId || !rect || !stageRef.current) return null;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const point = stageRef.current.worldPoint(x, y);
    return point ? { canvasId, x, y, point } : null;
  }, []);

  const createNodeFromDock = useCallback((kind: "richText" | "link") => {
    const target = dockCreateTarget();
    if (!target) return;
    setCanvasTool("select");
    void createNodeFromMenu(kind, target);
  }, [dockCreateTarget, createNodeFromMenu]);

  /** A saved edit is a new board item, placed beside its source and revealed immediately. */
  const finishImageSave = useCallback(async (result: { state: AppState; contentId: string }) => {
    applyState(result.state);
    const origin = pageRef.current?.origin;
    const canvasId = origin?.kind === "canvas" ? origin.canvasId : result.state.activeCanvasId;
    const canvas = result.state.canvases.find((entry) => entry.id === canvasId);
    if (!canvas) { showError("图片副本已保存，来源画布不存在"); return; }
    const source = canvas.nodes.find((node) => node.contentId === pageRef.current?.contentId);
    const view = importViewport();
    const point = source ? { x: source.x + source.width + 180, y: source.y + source.height / 2 }
      : { x: (view.width / 2 - view.x) / view.zoom, y: (view.height / 2 - view.y) / view.zoom };
    try {
      const next = await window.imageBoard.placeContent(result.contentId, canvasId, point);
      applyState(next);
      setCanvasTool("select");
      revealRef.current = { canvasId, contentId: result.contentId };
      pageActionRef.current = { canvasId };
      pageOriginElementRef.current = null;
      setPageOpen(false);
      showNotice("编辑后的图片已放到画布，原图保留");
    } catch (caught) {
      openPage(result.contentId, origin ?? { kind: "canvas", canvasId });
      showError(caught instanceof Error ? `副本已保存，放到画布失败：${caught.message}` : "副本已保存，放到画布失败，可从历史拖入");
    }
  }, [applyState, importViewport, openPage, showError, showNotice]);

  const importImageToCanvas = useCallback(async () => {
    if (busyRef.current || createNodeBusyRef.current) return;
    const target = dockCreateTarget();
    if (!target) return;
    createNodeBusyRef.current = true;
    try {
      const result = await window.imageBoard.openImageFile();
      if (!result) return;
      applyState(result.state);
      markBusy("正在导入图片…");
      const next = await window.imageBoard.placeContent(result.contentId, target.canvasId, target.point);
      applyState(next);
      setCanvasTool("select");
      const node = next.canvases.find((entry) => entry.id === target.canvasId)?.nodes.find((entry) => entry.contentId === result.contentId);
      if (node) {
        selectedNodeIdsRef.current = [node.id];
        setSelectedNodeIds([node.id]); setSelectedCardId(null); setSelectedEdgeIds([]);
        setFocusRequest({ nodeId: node.id, nonce: ++focusNonceRef.current });
      }
      showNotice("图片已放到画布");
    } catch (caught) { showError(caught instanceof Error ? caught.message : "图片导入失败"); }
    finally { createNodeBusyRef.current = false; markIdle(); }
  }, [applyState, dockCreateTarget, markBusy, markIdle, showError, showNotice]);

  const buildCreateMenu = (target: CreateMenuState) => ({
    x: target.x,
    y: target.y,
    items: [
      { label: "新建链接节点", onSelect: () => void createNodeFromMenu("link", target) },
      { label: "新建富文本节点", onSelect: () => void createNodeFromMenu("richText", target) },
    ],
  });

  // A menu anchored to a canvas that is no longer showing must not linger.
  useEffect(() => {
    if (!createMenu) return;
    if (viewMode !== "canvas" || state?.activeCanvasId !== createMenu.canvasId) setCreateMenu(null);
  }, [createMenu, state?.activeCanvasId, viewMode]);

  // ---- clipboard paste -------------------------------------------------------
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (viewMode !== "canvas" || pageRef.current || dialogRef.current || actionsRef.current) return;
      if (isEditableTarget(event.target)) return;
      const current = stateRef.current;
      if (!current?.activeCanvasId) return;
      event.preventDefault();
      const canvasId = current.activeCanvasId;
      const viewport = importViewport();
      const center = { x: (viewport.width / 2 - viewport.x) / viewport.zoom, y: (viewport.height / 2 - viewport.y) / viewport.zoom };
      markBusy("正在粘贴…");
      void window.imageBoard.pasteClipboard(canvasId, viewport).then((result) => {
        if (result.placed) {
          spawnNonceRef.current += 1;
          setSpawnFrom({ point: center, nonce: spawnNonceRef.current });
        }
        applyState(result.state);
        if (result.placed) showNotice("已粘贴到当前画布");
        else showInfo("剪贴板中没有可收纳的内容");
      }).catch((caught) => showError(caught instanceof Error ? caught.message : "粘贴失败")).finally(markIdle);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [actions, applyState, importViewport, markBusy, markIdle, page, showError, showInfo, showNotice, viewMode]);

  // Tray panel requests: navigate the main window (optionally opening a page).
  useEffect(() => {
    const api = window.imageBoard;
    if (typeof api.onNavigate !== "function") return;
    return api.onNavigate(async (navigate) => {
      const view = navigate.view ?? viewModeRef.current;
      if (view !== viewModeRef.current && await switchViewRef.current(view) === false) return;
      if (navigate.contentId) {
        const current = stateRef.current;
        const origin: PageOrigin = view === "library"
          ? { kind: "library" }
          : { kind: "canvas", canvasId: current?.activeCanvasId ?? "" };
        openPageRef.current(navigate.contentId, origin);
      }
    });
  }, []);

  useEffect(() => {
    if (!state || typeof window.imageBoard.takePendingImage !== "function") return;
    let alive = true;
    const open = async (result: { state: AppState; contentId: string } | null) => {
      if (!alive || !result || await pageNavigationGuardRef.current?.() === false) return;
      applyState(result.state);
      openPageRef.current(result.contentId, { kind: "canvas", canvasId: result.state.activeCanvasId });
    };
    const unsubscribe = window.imageBoard.onImageOpened((result) => { void open(result); });
    void window.imageBoard.takePendingImage().then(open).catch((error) => showError(String(error)));
    return () => { alive = false; unsubscribe(); };
  }, [Boolean(state), applyState, showError]);

  // External drops do nothing: collecting goes through the clipboard only.
  useEffect(() => {
    const block = (event: DragEvent) => { event.preventDefault(); };
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    return () => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    };
  }, []);

  // ---- global keyboard -------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // A mounted full page owns Escape and its editing shortcuts.
      if (pageRef.current) return;
      if (dialogRef.current || actionsRef.current) return;
      if (isEditableTarget(target)) return;
      // A live canvas gesture owns the keyboard (Esc also cancels relations).
      if (gestureBusyRef.current) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (event.shiftKey && !modifier && !event.altKey && !event.repeat && !event.isComposing && event.key.toLowerCase() === "a") {
        const blocked = document.querySelector(".canvas-context-menu, .dialog-card, .content-actions, .page-layer");
        if (viewModeRef.current === "canvas" && !busyRef.current && !createNodeBusyRef.current && stageRef.current && stateRef.current?.activeCanvasId && !blocked) {
          event.preventDefault();
          openCreateMenuFromKeyboard();
        }
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        toggleSidebarRef.current();
        return;
      }
      if (modifier && event.key.toLowerCase() === "c" && viewModeRef.current !== "settings") {
        const ids = viewModeRef.current === "canvas" ? canvasContentIdsRef.current : selectedContentIdsRef.current;
        if (ids.length > 0) {
          event.preventDefault();
          void copyContents(ids);
        }
        return;
      }
      if (!modifier && (event.key === "Delete" || event.key === "Backspace") && !event.repeat && viewModeRef.current === "canvas") {
        if (selectedNodeIdsRef.current.length > 0 || selectedEdgeIdsRef.current.length > 0) {
          event.preventDefault();
          void deleteCanvasSelection();
        }
        return;
      }
      if (event.key === "Escape") {
        // The create menu owns this Escape: its own listener closes it without
        // also clearing the selection or stepping out of a sub-canvas.
        if (createMenuRef.current) return;
        if (selectedNodeIdsRef.current.length > 0 || selectedContentIdsRef.current.length > 0 || selectedEdgeIdsRef.current.length > 0 || selectedCardIdRef.current) {
          event.preventDefault();
          clearSelection();
          return;
        }
        if (activeParentId) {
          event.preventDefault();
          void changeCanvas(activeParentId);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [activeParentId, changeCanvas, clearSelection, copyContents, deleteCanvasSelection, openCreateMenuFromKeyboard]);

  // ---- actions from the canvas surface ---------------------------------------
  const openContentFromNode = useCallback((contentId: string, origin: HTMLElement | null) => {
    const current = stateRef.current;
    if (!current || busyRef.current) return;
    openPage(contentId, { kind: "canvas", canvasId: current.activeCanvasId }, origin);
  }, [openPage]);

  const openCardMenu = useCallback((event: React.MouseEvent<HTMLElement> | null, canvasId: string) => {
    const element = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const rect = element?.getBoundingClientRect();
    setCardMenu({
      canvasId,
      x: event ? event.clientX : rect ? rect.left + 16 : 0,
      y: event ? event.clientY : rect ? rect.top + 16 : 0,
    });
    setEdgeMenu(null);
    setCreateMenu(null);
  }, []);

  const openEdgeMenu = useCallback((edgeId: string, clientX: number, clientY: number) => {
    setEdgeMenu({ edgeId, x: clientX, y: clientY });
    setCardMenu(null);
    setCreateMenu(null);
  }, []);

  const cardMenuTarget = cardMenu ? state?.canvases.find((canvas) => canvas.id === cardMenu.canvasId) ?? null : null;

  if (!state) return <div className="loading-card">{loadError ? <><strong>本地内容画布打开失败</strong><span>{loadError}</span><div className="loading-actions"><button className="primary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重试</button><button onClick={() => void window.imageBoard.closeWindow()}>退出</button></div></> : "正在打开本地内容画布…"}</div>;

  const sidebarActions = (
    <div className="sidebar-heading-actions">
          {!sidebarPinned && <button type="button" className="sidebar-pin" aria-label="固定侧边栏" title="固定侧边栏" onClick={toggleSidebar}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 3 6 6-4 1-4 4 1 4-3 1-6-6 1-3 4 1 4-4 1-4ZM8 16l-5 5" /></svg>固定</button>}
          <button type="button" className="sidebar-collapse" aria-label="收起侧边栏" title="收起侧边栏" onClick={dismissSidebar}><IconPanelLeft size={15} /></button>
        </div>
  );
  const sidebarInner = (
    <>
      {viewMode === "settings" && <div className="sidebar-heading">
        <button type="button" className="sidebar-back" aria-label="返回画布" title="返回画布" onClick={() => void switchView("canvas")}><IconArrowLeft size={15} /></button>
        <strong>设置</strong>
        {sidebarActions}
      </div>}
      <div className="sidebar-search">
        <IconSearch size={14} />
        <input ref={searchInputRef} value={viewMode === "settings" ? settingsQuery : treeQuery} placeholder={viewMode === "settings" ? "搜索设置…" : "搜索画布…"} aria-label={viewMode === "settings" ? "搜索设置" : "搜索画布"} onChange={(event) => (viewMode === "settings" ? setSettingsQuery : setTreeQuery)(event.target.value)} onKeyDown={(event) => { if (event.key !== "Escape" || event.nativeEvent.isComposing) return; event.preventDefault(); event.stopPropagation(); if (viewMode === "settings" ? settingsQuery : treeQuery) { (viewMode === "settings" ? setSettingsQuery : setTreeQuery)(""); return; } if (!sidebarPinnedRef.current) dismissSidebar(); else event.currentTarget.blur(); }} />
        {(sidebarPinned || viewMode === "settings") && (viewMode === "settings" ? settingsQuery : treeQuery) === "" && <kbd>Ctrl K</kbd>}
        {viewMode !== "settings" && !sidebarPinned && sidebarActions}
      </div>
      {viewMode === "settings" ? <SettingsNavigation section={settingsSection} onSectionChange={(section) => { setSettingsSection(section); cancelPeekClose(); }} query={settingsQuery} /> : <nav className="sidebar-nav" aria-label="工作区导航">
        <button className={viewMode === "canvas" ? "active" : undefined} onClick={() => switchView("canvas")}><IconGrid size={15} />画布</button>
        <button className={viewMode === "library" ? "active" : undefined} onClick={() => switchView("library")}><IconFolder size={15} />分类库</button>
      </nav>}
      {viewMode === "canvas" && <CanvasTree canvases={state.canvases} activeCanvasId={state.activeCanvasId} query={treeQuery} onEnter={(canvasId) => void changeCanvas(canvasId)} onCreateRoot={() => { clearSelection(); void update(() => window.imageBoard.createCanvas()); }} onCreateChild={(parentId) => { clearSelection(); void update(() => window.imageBoard.createCanvas(parentId)); }} onRename={(canvasId) => void renameCanvasById(canvasId)} onDelete={(canvasId) => void deleteCanvas(canvasId)} onUngroup={ungroupCanvasById} onMove={moveCanvasNode} />}
      <footer className="sidebar-footer">
        <div className="footer-avatar"><AppLogo size={20} /></div>
        <div className="footer-copy"><strong>PicBoard 本地工作区</strong><span>{state.canvases.length} 个画布 · {contentCount} 项内容</span></div>
        <button type="button" className={`icon-button sidebar-settings${viewMode === "settings" ? " active" : ""}`} aria-label="打开设置" title="设置" aria-pressed={viewMode === "settings"} onClick={() => switchView("settings")}><IconGear size={16} /></button>
      </footer>
    </>
  );

  const canvasView = activeCanvas ? (
    <>
      <CanvasStage
        key={activeCanvas.id}
        ref={stageRef}
        state={state}
        canvas={activeCanvas}
        contents={state.contents}
        initialViewport={viewportCacheRef.current.get(activeCanvas.id) ?? activeCanvas.viewport}
        busy={busy}
        snapToGrid={snapToGrid}
        interactionMode={canvasTool}
        gridSize={desktopSettings?.gridSize ?? 24}
        appearance={canvasAppearance}
        spawnFrom={spawnFrom}
        enterMotion={enterMotionRef.current}
        selectedNodeIds={selectedNodeIds}
        selectedCardId={selectedCardId}
        selectedEdgeIds={selectedEdgeIds}
        focusRequest={focusRequest}
        onSelectNode={selectNode}
        onSelectNodes={selectNodes}
        onSelectCard={selectCard}
        onSelectEdge={selectEdge}
        onOpenContent={openContentFromNode}
        onOpenCanvas={(canvasId) => void changeCanvas(canvasId)}
        onNodeActions={openNodeActions}
        onCardMenu={openCardMenu}
        onEdgeMenu={openEdgeMenu}
        onCanvasContextMenu={openCreateMenu}
        onNodesMove={(positions) => void moveNodes(positions)}
        onNodesDrop={(nodeIds, cardId) => void moveNodesIntoCard(nodeIds, cardId)}
        onCardMove={moveCard}
        onEdgeCreate={(fromNodeId, toNodeId) => void createEdge(fromNodeId, toNodeId)}
        onViewport={(viewport) => persistViewport(activeCanvas.id, viewport)}
        onZoomChange={setZoomDisplay}
        onInteractionChange={handleInteractionChange}
      />
      {canvasToolbarPresence.mounted && <div className={`canvas-dock-motion motion-fade${drawerLayout === "overlay" && historyOpen ? " has-overlay-history" : ""}`} data-motion={canvasToolbarPresence.phase}>
        <CanvasDock tool={canvasTool} onToolChange={setCanvasTool} onCreate={createNodeFromDock} onImportImage={() => void importImageToCanvas()}
          onCreateCanvas={() => { clearSelection(); void update(() => window.imageBoard.createCanvas(activeCanvas.id)); }}
          historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen((open) => !open)}
          snapToGrid={snapToGrid} onToggleSnap={toggleSnap} zoom={zoomDisplay} onZoom={(delta) => stageRef.current?.zoomBy(delta)}
          onLocateAll={() => { if (!stageRef.current?.locateAll()) showInfo("当前画布还没有节点"); }}
          showViewControls={showControls} disabled={busy} />
      </div>}
    </>
  ) : (
    <div className="empty-canvas"><strong>画布不存在</strong><span>请在左侧选择或新建画布</span></div>
  );

  return <main ref={appShellRef} className={`app-shell${maximized ? " is-maximized" : ""}${viewMode === "canvas" ? " is-canvas-workspace" : ""}${page ? " has-content-page" : ""}`}>
    {!maximized && <div className="window-resize-handles" aria-hidden="true">
      {(["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"] as WindowResizeDirection[]).map((direction) => <div key={direction} className={`window-resize-edge resize-${direction}`} data-resize-direction={direction} onPointerDown={(event) => resizeWindowFromEdge(event, direction)} />)}
    </div>}
    <header className="topbar">
      <div className="topbar-start">
      <button
        type="button"
        className={`icon-button no-drag sidebar-toggle${sidebarPinned ? " active" : ""}`}
        title={sidebarPinned ? "收起侧边栏 (Ctrl+Shift+S)" : "固定侧边栏 (Ctrl+Shift+S)"}
        aria-label={sidebarPinned ? "收起侧边栏 (Ctrl+Shift+S)" : "固定侧边栏 (Ctrl+Shift+S)"}
        aria-controls="workspace-sidebar"
        aria-pressed={sidebarPinned}
        aria-expanded={sidebarVisible}
        onClick={toggleSidebar}
        onPointerEnter={() => { sidebarPointerInsideRef.current = true; openPeek(); }}
        onPointerLeave={() => { sidebarPointerInsideRef.current = false; schedulePeekClose(); }}
        onBlur={() => schedulePeekClose()}
      >
        <IconPanelLeft size={16} />
      </button>
      <div className="window-drag-region" onDoubleClick={(event) => { if (!(event.target as Element).closest("button, input, a")) void toggleMaximize(); }} onPointerDown={startTitlebarPointer} onPointerMove={titleDragMove} onPointerUp={() => { titleDragRef.current = null; }} onPointerCancel={() => { titleDragRef.current = null; }} onLostPointerCapture={() => { titleDragRef.current = null; }}>
        <div className="brand-mark"><AppLogo size={26} /></div>
        {page && pagePresence.mounted ? (
          <div className="brand-copy page-crumbs motion-slide-down" data-motion={pagePresence.phase}>
            <span className="crumb-path">
              <button
                type="button"
                className="crumb-origin"
                onClick={() => void requestPageClose()}
                title="返回（Esc）"
                aria-label={`返回到${pageOriginLabel}`}
              >
                <IconArrowLeft size={14} /><span>{pageOriginLabel}</span>
              </button>
              <span aria-hidden="true"> › </span>
              <strong>{pageContent ? contentTitle(pageContent) : "内容"}</strong>
            </span>
          </div>
        ) : viewMode === "canvas" ? (
          <nav className="canvas-trail no-drag" aria-label="画布层级">
            {breadcrumb.map((canvas, index) => (
              <Fragment key={canvas.id}>
                {index > 0 && <span className="canvas-trail-sep" aria-hidden="true">›</span>}
                <button
                  type="button"
                  ref={canvas.id === activeCanvas?.id ? trailCurrentRef : undefined}
                  className={`no-drag canvas-trail-item${canvas.id === activeCanvas?.id ? " is-current" : ""}`}
                  title={canvas.name}
                  aria-current={canvas.id === activeCanvas?.id ? "page" : undefined}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={() => void changeCanvas(canvas.id)}
                >{canvas.name}</button>
              </Fragment>
            ))}
            <button
              type="button"
              className="canvas-trail-add no-drag"
              title={activeCanvas ? "新建子画布" : "新建画布"}
              aria-label={activeCanvas ? "新建子画布" : "新建画布"}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={() => {
                clearSelection();
                void update(() => activeCanvas ? window.imageBoard.createCanvas(activeCanvas.id) : window.imageBoard.createCanvas());
              }}
            >＋</button>
          </nav>
        ) : (
          <div className="brand-copy">
            <strong>{viewMode === "library" ? "分类库" : "设置"}</strong>
            <span>{viewMode === "library" ? `${contentCount} 项内容` : "画布、剪贴板与窗口行为"}</span>
          </div>
        )}
      </div>
      </div>
      <div className="topbar-actions">

        <button className="icon-button no-drag" aria-label={maximized ? "还原小窗" : "最大化窗口"} title={maximized ? "还原小窗" : "最大化窗口"} onClick={() => void toggleMaximize()}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">{maximized ? <><path d="M5 5V2h9v9h-3" /><rect x="2" y="5" width="9" height="9" rx="1" /></> : <rect x="2.5" y="2.5" width="11" height="11" rx="1" />}</svg></button>
        <button className="icon-button no-drag" aria-label="最小化窗口" title="最小化窗口" onClick={() => void window.imageBoard.minimizeWindow()}><IconMinus size={15} /></button>
        <button className="icon-button no-drag close-window" aria-label="关闭（按设置处理）" title="关闭（按设置处理）" onClick={() => void window.imageBoard.closeWindow()}><IconClose size={15} /></button>
      </div>
      {busy && <span className="busy-chip" role="status"><span className="busy-chip-dot" aria-hidden="true" />{busyLabel ?? "正在处理…"}</span>}
    </header>
    <div ref={setWorkspaceToolbarHost} className="workspace-toolbar-host" />
    <div className="workspace">
      <aside
        id="workspace-sidebar" aria-label="工作区侧边栏" className={`sidebar${sidebarPinned ? " is-pinned" : sidebarPeek ? " is-peeking" : " closed"}`}
        aria-hidden={sidebarVisible ? undefined : true}
        onContextMenuCapture={(event) => { if (!sidebarPeekRef.current) return; sidebarMenuOriginRef.current = (event.target as Element).closest<HTMLElement>(".tree-node"); cancelPeekClose(); }}
        onDragStartCapture={() => { if (!sidebarPeekRef.current) return; sidebarDraggingRef.current = true; cancelPeekClose(); }}
        onPointerEnter={() => {
          sidebarPointerInsideRef.current = true;
          cancelPeekClose();
          // Entering a closing panel must never reopen an explicit dismissal.
        }}
        onPointerLeave={() => {
          sidebarPointerInsideRef.current = false;
          schedulePeekClose();
        }}
        onFocus={() => {
          if (sidebarPinnedRef.current) return;
          cancelPeekClose();
          setSidebarPeek(true);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && (event.currentTarget.contains(next) || (next instanceof Element && next.closest(".sidebar-toggle")))) return;
          schedulePeekClose();
        }}
      >
        <div ref={attachSidebarContent} className="sidebar-content">{sidebarInner}</div>
      </aside>
      <div ref={workspaceMainRef} className="workspace-main">
        <div ref={workspaceViewRef} className={`workspace-view${drawerLayout === "overlay" && historyOpen ? " has-history-overlay" : ""}`} aria-hidden={page ? true : undefined}>
          {viewMode === "canvas" ? canvasView
            : viewMode === "library" ? (
              <LibraryView
                state={state}
                toolbarHost={page ? null : workspaceToolbarHost}
                selectedIds={selectedContentIds}
                onSelect={(contentId, toggle) => setSelectedContentIds((current) => applySelection(current, contentId, toggle))}
                onClearSelection={() => setSelectedContentIds([])}
                onOpen={(contentId) => openPage(contentId, { kind: "library" })}
                onQuickActions={openLibraryActions}
              />
            ) : (
              <SettingsPage
                section={settingsSection}
                state={state}
                pathSettings={pathSettings}
                desktopSettings={desktopSettings}
                canvasAppearance={canvasAppearance}
                onPathSettingsChange={(patch) => setPathSettings((current) => ({ ...current, ...patch }))}
                onCanvasAppearanceChange={(patch) => setCanvasAppearance((current) => ({
                  ...current,
                  ...patch,
                  ...(patch.background ? { backgroundCustomized: true } : null),
                  ...(patch.patternColor || patch.patternOpacity !== undefined ? { inkCustomized: true } : null),
                }))}
                onDesktopSettingsChange={(patch) => void saveDesktopSettings(patch)}
                onAddCategory={async () => { const name = await openPrompt("新建分类"); if (!name) return false; return update(() => window.imageBoard.createCategory(name)); }}
              />
            )}
          {viewMode !== "library" && selectionPresence.mounted && selectionSnapshotRef.current.label !== "" && (
            <div className={`selection-toolbar motion-fade`} data-motion={selectionPresence.phase}>
              <span>{selectionSnapshotRef.current.label}</span>
              {selectionSnapshotRef.current.canGroup && (
                <button onClick={() => void groupSelectionIntoCanvas(selectedNodeIds)}>创建子画布</button>
              )}
              {selectionSnapshotRef.current.canAct && <button onClick={openToolbarActions}>操作</button>}
              <button onClick={clearSelection}>取消选择</button>
            </div>
          )}
        </div>
        {viewMode === "canvas" && (
          <div ref={historySlotRef} className={`history-slot${historyOpen ? " open" : ""}${drawerLayout === "overlay" ? " overlay" : ""}`} aria-hidden={page ? true : undefined}>
            <HistoryDrawer
              state={state}
              open={historyOpen}
              captureEnabled={captureEnabled}
              onToggleCapture={(next) => void toggleCapture(next)}
              onClose={() => setHistoryOpen(false)}
              onOpen={(contentId) => openPage(contentId, { kind: "canvas", canvasId: state.activeCanvasId })}
              onQuickActions={openHistoryActions}
              onDropToCanvas={dropHistoryContent}
            />
          </div>
        )}
        {pagePresence.mounted && page && (
          <div className="page-layer motion-fade" data-motion={pagePresence.phase}>
            <ContentPage
              key={page.contentId}
              state={state}
              contentId={page.contentId}
              toolbarHost={workspaceToolbarHost}
              navigationGuardRef={pageNavigationGuardRef}
              onOpenContent={(contentId) => openPage(contentId, page.origin)}
              onImageSaved={finishImageSave}
              onState={applyState}
              onClose={closePage}
              onCopy={(ids) => void copyContents(ids)}
              onQuickActions={(origin, contentId) => openContentActions("page", [contentId], [], anchorForElement(origin))}
              onOpenCanvas={openCanvasFromPage}
              onError={showError}
              onNotice={showNotice}
            />
          </div>
        )}
      </div>
    </div>
    {actionsPresence.mounted && shownActions && (
      <ContentActions
        key={shownActions.key}
        motion={actionsPresence.phase}
        state={state}
        context={shownActions.context}
        contentIds={shownActions.contentIds}
        nodeIds={shownActions.nodeIds}
        anchor={shownActions.anchor}
        onClose={closeActions}
        onUpdate={applyState}
        onError={showError}
        onNotice={showNotice}
        onOpen={(contentId) => openPage(contentId, viewMode === "library" ? { kind: "library" } : { kind: "canvas", canvasId: state.activeCanvasId })}
        onCopy={(ids) => void copyContents(ids)}
        onRename={(content) => void renameContent(content)}
        onDelete={(ids) => void requestDeleteContents(ids)}
        onRemoveNodes={(ids) => void removeNodes(ids)}
        onGroupIntoCanvas={(ids) => void groupSelectionIntoCanvas(ids)}
      />
    )}
    <ContextMenu
      menu={createMenu ? buildCreateMenu(createMenu) : null}
      onClose={() => setCreateMenu(null)}
    />
    <ContextMenu
      menu={cardMenu && cardMenuTarget?.frame ? {
        x: cardMenu.x,
        y: cardMenu.y,
        items: [
          { label: "进入", onSelect: () => void changeCanvas(cardMenuTarget.id) },
          { label: "重命名", onSelect: () => void renameCanvasById(cardMenuTarget.id) },
          { label: "解组", onSelect: () => ungroupCanvasById(cardMenuTarget.id) },
          { label: "删除", danger: true, onSelect: () => void deleteCanvas(cardMenuTarget.id) },
        ],
      } : null}
      onClose={() => setCardMenu(null)}
    />
    <ContextMenu
      menu={edgeMenu ? {
        x: edgeMenu.x,
        y: edgeMenu.y,
        items: [{ label: "删除连线", danger: true, onSelect: () => void deleteEdges([edgeMenu.edgeId]) }],
      } : null}
      onClose={() => setEdgeMenu(null)}
    />
    <ContextMenu
      menu={topbarMenu ? {
        x: topbarMenu.x,
        y: topbarMenu.y,
        items: [
          ...(viewMode === "canvas" ? [
            { label: historyOpen ? "收起剪贴板历史" : "展开剪贴板历史", onSelect: () => setHistoryOpen((open) => !open) },
            { label: showControls ? "收起画布工具" : "展开画布工具", onSelect: () => setShowControls((visible) => !visible) },
          ] : []),
        ],
      } : null}
      onClose={() => setTopbarMenu(null)}
    />
    <ToastView toast={toast} onClose={clearToast} />
    {dialogPresence.mounted && shownDialog && <Dialog dialog={shownDialog} motion={dialogPresence.phase} onClose={clearDialog} />}
  </main>;
}

function Dialog({ dialog, motion, onClose }: { dialog: DialogState; motion: "enter" | "idle" | "exit"; onClose: () => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.value : "");
  const [validation, setValidation] = useState<{ dialog: DialogState; message: string } | null>(null);
  const validationMessage = validation?.dialog === dialog ? validation.message : "";
  const [position, setPosition] = useState<PanelAnchor | null>(null);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const container = card?.parentElement;
    if (!card || !container || !dialog.anchor) return;
    setPosition({
      left: Math.max(12, Math.min(dialog.anchor.left, container.clientWidth - card.offsetWidth - 12)),
      top: Math.max(12, Math.min(dialog.anchor.top, container.clientHeight - card.offsetHeight - 12)),
    });
  }, [dialog]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    const focusable = () => {
      const card = cardRef.current;
      if (!card) return null;
      const list = Array.from(card.querySelectorAll<HTMLElement>('button, input, [href], [tabindex]:not([tabindex="-1"])'));
      return list.filter((element) => !element.hasAttribute("disabled"));
    };
    if (dialog.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      cancelRef.current?.focus();
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (motionRef.current === "exit") return;
        event.preventDefault();
        event.stopPropagation();
        finish(dialog.kind === "prompt" ? null : false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements || elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === cardRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      (previouslyFocusedRef.current as HTMLElement | null)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (result: string | null | boolean) => {
    if (motionRef.current === "exit") return;
    dialog.resolve(result as never);
    onClose();
  };
  const submit = () => {
    if (dialog.kind === "confirm") {
      finish(true);
      return;
    }
    const message = dialog.validate?.(value) ?? null;
    if (message) {
      setValidation({ dialog, message });
      inputRef.current?.focus();
      return;
    }
    finish(value);
  };
  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      finish(dialog.kind === "prompt" ? null : false);
    }
  };
  return <div className="dialog-backdrop motion-fade" data-motion={motion} data-esc-layer onMouseDown={() => finish(dialog.kind === "prompt" ? null : false)}>
    <section
      ref={cardRef}
      className="dialog-card motion-pop"
      data-motion={motion}
      data-esc-layer
      style={position ? { position: "absolute", left: position.left, top: position.top } : undefined}
      role="alertdialog"
      aria-modal="true"
      aria-label={dialog.title}
      onKeyDown={handleKey}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <strong>{dialog.title}</strong>
      {dialog.kind === "prompt" ? (
        <>
          <input
            ref={inputRef}
            value={value}
            aria-invalid={validationMessage ? "true" : undefined}
            onChange={(event) => { setValue(event.target.value); setValidation(null); }}
            onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") submit(); if (event.key === "Escape") finish(null); }}
          />
          {validationMessage && <p className="dialog-error" role="alert">{validationMessage}</p>}
        </>
      ) : <p>{dialog.message}</p>}
      <div className="dialog-actions">
        <button ref={cancelRef} onClick={() => finish(dialog.kind === "prompt" ? null : false)}>取消</button>
        <button className={dialog.kind === "confirm" ? "danger-button" : "primary-button"} onClick={submit}>{dialog.kind === "confirm" ? "删除" : "确定"}</button>
      </div>
    </section>
  </div>;
}

export default App;
