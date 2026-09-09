import { QuickActions } from "./ui/ImageActions";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import type { AppState, CanvasViewport, ImageBoardApi, ImageRecord, ImportViewport } from "../../shared/image-board";
import { BloubBall } from "./BloubBall";
import { DEFAULT_BALL_SETTINGS, readBallSettings, saveBallSettings, type BallSettings } from "./ball-settings";
import { COLORS, SHAPES } from "./third-party/bloub/skins";
import { createMiniMapGeometry, miniMapToWorld } from "../../shared/minimap-geometry";
import { applySelection, imagesInSelectionRect, mergeSelection, normalizeSelectionRect, type SelectionRect } from "../../shared/canvas-selection";
import { clampPreviewOffset, clampPreviewZoom, fitPreviewSize, zoomAroundPoint } from "../../shared/preview-geometry";
import { ToastView, toastChannel, type ToastKind, type ToastMessage } from "./ui/Toast";
import { IconClose, IconDots, IconGear, IconMinus } from "./ui/Icons";
// Controls lane exports (fixed contract §通用控件; landed by the controls lane).
import { ColorPicker } from "./ui/ColorPicker";
import { DirectoryField } from "./ui/DirectoryField";
import { Select } from "./ui/Select";
import { ShellSettings } from "./ui/ShellSettings";

type ViewMode = "canvas" | "library" | "settings";
type DialogState = ({ kind: "prompt"; title: string; value: string; resolve: (value: string | null) => void } | { kind: "confirm"; title: string; message: string; resolve: (value: boolean) => void }) & { anchor?: PanelAnchor | null };
type PathSettings = { filePath: string; classifiedPath: string; temporaryPath: string };
type PanelAnchor = { left: number; top: number };
/** Ball intake feedback states (contract §球). */
type IntakeState = "idle" | "over" | "receiving" | "success" | "error";
/** Panel geometry lifecycle; content only mounts once the host window really matches. */
type PanelPhase = "collapsed" | "opening" | "expanded" | "closing";

const ACCEPTED_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DEFAULT_VIEWPORT: CanvasViewport = { x: -900, y: -500, zoom: 1 };
const PATH_SETTINGS_KEY = "quick-image-board.path-settings";
const DEFAULT_PATH_SETTINGS: PathSettings = { filePath: "quick-image-board", classifiedPath: "quick-image-board/classified", temporaryPath: "quick-image-board/pending" };

const SHAPE_LABELS: Record<string, string> = {
  cercle: "圆形",
  galet: "鹅卵石",
  squircle: "圆角方",
  capsule: "胶囊",
  triangle: "三角",
  hexagone: "六角",
  nuage: "云朵",
  goutte: "水滴",
};

const ANIMATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "random", label: "随机表情" },
  { value: "rest", label: "安静呼吸" },
  { value: "spark", label: "更多动效" },
];

function readPathSettings(): PathSettings {
  try {
    const raw = window.localStorage.getItem(PATH_SETTINGS_KEY);
    const value = raw ? JSON.parse(raw) as Partial<PathSettings> : {};
    return {
      filePath: typeof value.filePath === "string" ? value.filePath : DEFAULT_PATH_SETTINGS.filePath,
      classifiedPath: typeof value.classifiedPath === "string" ? value.classifiedPath : DEFAULT_PATH_SETTINGS.classifiedPath,
      temporaryPath: typeof value.temporaryPath === "string" ? value.temporaryPath : DEFAULT_PATH_SETTINGS.temporaryPath,
    };
  } catch { return { ...DEFAULT_PATH_SETTINGS }; }
}

function imageList(state: AppState, canvasId: string) {
  const canvas = state.canvases.find((item) => item.id === canvasId);
  return canvas?.imageIds.map((id) => state.images[id]).filter(Boolean) ?? [];
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.isContentEditable || element?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

function hasBlockingDialog() {
  return Boolean(document.querySelector('.dialog-card[role="alertdialog"][aria-modal="true"]'));
}

/**
 * Temporary seam (contract: cross-lane types may be missing until merge).
 * The ball lane is about to add `intakeState/intakeKey/intakeCount/variant` to
 * BloubBall with exactly these semantics; extra props are ignored by the
 * current implementation, so this cast is safe both before and after merge.
 */
type IntakeBallProps = ComponentProps<typeof BloubBall> & {
  intakeState?: IntakeState;
  intakeKey?: number;
  intakeCount?: number;
  variant?: "ball" | "brand" | "preview";
};
function IntakeBall(props: IntakeBallProps) {
  return <BloubBall {...(props as ComponentProps<typeof BloubBall>)} />;
}

/** Optional host surface still landing in the native lane (contract §Host). */
type HostExtensions = {
  onExpandedChange?: (listener: (expanded: boolean) => void) => () => void;
};
function hostApi(): ImageBoardApi & HostExtensions {
  return window.imageBoard as ImageBoardApi & HostExtensions;
}

function App({ initialExpanded }: { initialExpanded: boolean }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [phase, setPhaseState] = useState<PanelPhase>(initialExpanded ? "expanded" : "collapsed");
  const phaseRef = useRef<PanelPhase>(initialExpanded ? "expanded" : "collapsed");
  const desiredRef = useRef(initialExpanded);
  const hostFlightRef = useRef<{ seq: number; target: boolean } | null>(null);
  const hostSeqRef = useRef(0);
  const exitTimerRef = useRef<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [showControls, setShowControls] = useState(false);
  const [ballSettings, setBallSettings] = useState<BallSettings>(() => readBallSettings(window.localStorage));
  const [pathSettings, setPathSettings] = useState<PathSettings>(() => readPathSettings());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewIdRef = useRef<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const titleDragRef = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const titleDragBusy = useRef(false);
  const titleDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = titleDragRef.current;
    if (!start || start.pointer !== event.pointerId || !(event.buttons & 1) || titleDragBusy.current) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
    titleDragRef.current = null;
    titleDragBusy.current = true;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void window.imageBoard.startTitlebarDrag().then(() => setMaximized(false)).catch((caught) => showError(caught instanceof Error ? caught.message : "拖动窗口失败")).finally(() => { titleDragBusy.current = false; });
  };
  const [maximized, setMaximized] = useState(false);
  const maximizeBusy = useRef(false);
  const toggleMaximize = async () => {
    if (maximizeBusy.current) return;
    maximizeBusy.current = true;
    try { setMaximized(await window.imageBoard.toggleMaximized()); }
    catch (caught) { showError(caught instanceof Error ? caught.message : "切换窗口大小失败"); }
    finally { maximizeBusy.current = false; }
  };
  const [actionsOpen, setActionsOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<PanelAnchor | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const copyBusyRef = useRef(false);
  const deleteBusyRef = useRef(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastChannelRef = useRef<ReturnType<typeof toastChannel> | null>(null);
  if (!toastChannelRef.current) toastChannelRef.current = toastChannel();
  const [failureLabel, setFailureLabel] = useState("");
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom);
  const [worldOffset, setWorldOffset] = useState({ x: DEFAULT_VIEWPORT.x, y: DEFAULT_VIEWPORT.y });
  const worldOffsetRef = useRef(worldOffset);
  worldOffsetRef.current = worldOffset;
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [quickActionsSource, setQuickActionsSource] = useState<HTMLElement | null>(null);
  const [intake, setIntake] = useState<{ state: IntakeState; key: number }>({ state: "idle", key: 0 });
  const [intakeCount, setIntakeCount] = useState(0);
  const intakeKeyRef = useRef(0);
  const intakeTimerRef = useRef<number | null>(null);
  const intakeStateRef = useRef<IntakeState>("idle");
  const importSeqRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const appShellRef = useRef<HTMLElement>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number; pointerId: number } | null>(null);
  const selectionRef = useRef<{ start: { x: number; y: number }; additive: boolean; pointerId: number } | null>(null);
  const selectionRectRef = useRef<SelectionRect | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const spacePressedRef = useRef(false);
  const [spacePressed, setSpacePressed] = useState(false);

  const activeCanvas = state?.canvases.find((canvas) => canvas.id === state.activeCanvasId);
  const canvasImages = state && activeCanvas ? imageList(state, activeCanvas.id) : [];
  const previewImage = previewId && state?.images[previewId];
  const panelVisible = phase === "expanded" || phase === "closing";
  const dialogOpen = dialog !== null;

  // ---- single feedback outlet -------------------------------------------------
  const showToast = useCallback((kind: ToastKind, message: string) => {
    const next = toastChannelRef.current?.next(kind, message) ?? null;
    setToast(next);
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

  // ---- intake (collapsed ball feedback) --------------------------------------
  const pushIntake = useCallback((nextState: IntakeState, settleMs = 0) => {
    intakeStateRef.current = nextState;
    intakeKeyRef.current += 1;
    setIntake({ state: nextState, key: intakeKeyRef.current });
    if (intakeTimerRef.current !== null) {
      window.clearTimeout(intakeTimerRef.current);
      intakeTimerRef.current = null;
    }
    if (settleMs > 0) {
      intakeTimerRef.current = window.setTimeout(() => {
        intakeTimerRef.current = null;
        intakeStateRef.current = "idle";
        intakeKeyRef.current += 1;
        setIntake({ state: "idle", key: intakeKeyRef.current });
      }, settleMs);
    }
  }, []);

  const applyState = useCallback((next: AppState) => {
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

  const clearInteraction = useCallback(() => {
    setActionsOpen(false);
    setSelectedIds([]);
    previewIdRef.current = null;
    setPreviewId(null);
    setHoveredId(null);
    setSelectionAnchor(null);
    setQuickActionsSource(null);
  }, []);

  const clearDialog = useCallback(() => setDialog(null), []);

  // ---- panel geometry: host-synced lifecycle (A6) -----------------------------
  const setPhase = useCallback((next: PanelPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const settleCollapsed = useCallback(() => {
    clearInteraction();
    clearToast();
    setPhase("collapsed");
  }, [clearInteraction, clearToast, setPhase]);

  const cancelExitTimer = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const callHost = useCallback((target: boolean) => {
    const flight = hostFlightRef.current;
    if (flight) {
      // Reuse an in-flight call with the same target; a different target is
      // reconciled when the flight settles, so IPC never stacks.
      if (flight.target === target) return;
      return;
    }
    const seq = hostSeqRef.current += 1;
    hostFlightRef.current = { seq, target };
    window.imageBoard.setExpanded(target).then(() => {
      if (hostFlightRef.current?.seq !== seq) return;
      hostFlightRef.current = null;
      if (target) {
        setPhase("expanded");
      } else {
        settleCollapsed();
      }
      // If the user changed intent while the call was in flight, drive towards
      // the newest target now (exactly one follow-up call).
      if (desiredRef.current !== target) {
        const desired = desiredRef.current;
        if (desired && phaseRef.current === "collapsed") {
          setPhase("opening");
          callHost(true);
        } else if (!desired && phaseRef.current === "expanded") {
          setPhase("closing");
          exitTimerRef.current = window.setTimeout(() => {
            exitTimerRef.current = null;
            callHost(false);
          }, 140);
        }
      }
    }).catch((caught) => {
      if (hostFlightRef.current?.seq !== seq) return;
      hostFlightRef.current = null;
      // The window never reached the requested geometry; fall back to the
      // geometry that is still true and let the UI recover visibly.
      if (target) {
        desiredRef.current = false;
        settleCollapsed();
      } else {
        desiredRef.current = true;
        setPhase("expanded");
        setFailureLabel("");
      }
      showError(caught instanceof Error ? caught.message : target ? "画板展开失败" : "画板收起失败");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleCollapsed, setPhase, showError]);

  const requestExpand = useCallback((nextOpen: boolean) => {
    desiredRef.current = nextOpen;
    const current = phaseRef.current;
    if (nextOpen) {
      if (current === "collapsed") {
        cancelExitTimer();
        setPhase("opening");
        callHost(true);
      } else if (current === "closing") {
        const collapseFlight = hostFlightRef.current && hostFlightRef.current.target === false;
        if (collapseFlight) {
          // The collapse is already on the wire; the flight's own resolution
          // sees the newest intent (true) and reopens exactly once.
        } else {
          // Exit not yet sent: abort the exit; window is still expanded.
          cancelExitTimer();
          setPhase("expanded");
        }
      }
      // opening/expanded: already heading there (in-flight calls converge).
    } else {
      if (current === "expanded") {
        setPhase("closing");
        exitTimerRef.current = window.setTimeout(() => {
          exitTimerRef.current = null;
          callHost(false);
        }, 140);
      } else if (current === "opening") {
        // In-flight expand completes, then the follow-up collapses.
      }
      // collapsed/closing: nothing to do.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callHost, cancelExitTimer, setPhase]);

  // Host-initiated geometry events (tray open/close, OS close→float/quit
  // handled by native): adopt the confirmed geometry without re-invoking.
  // Events matching our own in-flight call are ignored: the flight's own
  // resolution reconciles to the newest user intent exactly once.
  useEffect(() => {
    const api = hostApi();
    if (typeof api.onExpandedChange !== "function") return;
    const unsubscribe = api.onExpandedChange((nowOpen: boolean) => {
      const flight = hostFlightRef.current;
      if (flight && flight.target === nowOpen) return;
      if (flight) hostFlightRef.current = null;
      desiredRef.current = nowOpen;
      if (nowOpen) {
        cancelExitTimer();
        setPhase("expanded");
      } else {
        clearInteraction();
        clearToast();
        setPhase("collapsed");
      }
    });
    return unsubscribe;
  }, [cancelExitTimer, clearInteraction, clearToast, setPhase]);

  useEffect(() => () => {
    cancelExitTimer();
    if (intakeTimerRef.current !== null) window.clearTimeout(intakeTimerRef.current);
    dragDepthRef.current = 0;
  }, [cancelExitTimer]);

  // ---- data load --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void window.imageBoard.loadState().then((next) => {
      if (cancelled) return;
      applyState(next);
    }).catch((caught) => {
      if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "本地数据加载失败");
    });
    return () => { cancelled = true; };
  }, [applyState, loadAttempt]);

  useEffect(() => saveBallSettings(window.localStorage, ballSettings), [ballSettings]);
  useEffect(() => {
    try { window.localStorage.setItem(PATH_SETTINGS_KEY, JSON.stringify(pathSettings)); } catch { /* local preference storage is optional */ }
  }, [pathSettings]);

  useEffect(() => {
    const viewport = state?.canvases.find((canvas) => canvas.id === state.activeCanvasId)?.viewport ?? DEFAULT_VIEWPORT;
    setZoom(viewport.zoom);
    setWorldOffset({ x: viewport.x, y: viewport.y });
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

  // ---- clipboard paste (business semantics untouched) --------------------------
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!panelVisible || busy || !state?.activeCanvasId || viewMode !== "canvas" || isEditableTarget(target) || target?.closest("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      markBusy("正在粘贴…");
      void window.imageBoard.pasteImage(state.activeCanvasId).then((result) => {
        applyState(result.state);
        if (result.imported) showNotice("图片已粘贴到当前画布");
        else showInfo("剪贴板中没有图片");
      }).catch((caught) => showError(caught instanceof Error ? caught.message : "粘贴失败")).finally(markIdle);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, busy, panelVisible, state?.activeCanvasId, viewMode]);

  const currentCanvasIds = useMemo(() => new Set(canvasImages.map((image) => image.id)), [canvasImages]);
  const libraryImageIds = useMemo(() => new Set(Object.values(state?.images ?? {}).filter((image) => image.status === "classified").map((image) => image.id)), [state?.images]);

  const removeFromCanvas = useCallback(async (ids: string[]) => {
    if (!state || viewMode !== "canvas" || ids.length === 0 || busy) return;
    const targetIds = ids.filter((id) => currentCanvasIds.has(id));
    if (targetIds.length === 0) return;
    markBusy();
    try {
      let next = state;
      for (const id of targetIds) next = await window.imageBoard.removeImageFromCanvas(id);
      applyState(next);
      setSelectedIds((current) => current.filter((id) => !targetIds.includes(id)));
      setHoveredId((current) => current && targetIds.includes(current) ? null : current);
      setSelectionAnchor(null);
      setPreviewId((current) => current && targetIds.includes(current) ? null : current);
      showNotice(`已从画布移除 ${targetIds.length} 张图片`);
    } catch (caught) { showError(caught instanceof Error ? caught.message : "移除失败"); }
    finally { markIdle(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyState, busy, currentCanvasIds, state, viewMode]);

  const copyFiles = useCallback(async (ids: string[]) => {
    if (!state || ids.length === 0 || busy || copyBusyRef.current) return;
    const targetIds = ids.filter((id) => Boolean(state.images[id]));
    if (targetIds.length === 0) return;
    copyBusyRef.current = true;
    markBusy("正在复制图片文件…");
    try {
      const result = await window.imageBoard.copyImageFiles(targetIds);
      if (result.copied === targetIds.length && result.copied > 1) showNotice(`已复制 ${result.copied} 个图片文件`);
      else if (result.copied > 0) showNotice("已复制图片文件");
      else showInfo("没有复制图片文件");
    } catch (caught) { showError(caught instanceof Error ? caught.message : "复制失败"); }
    finally {
      copyBusyRef.current = false;
      markIdle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, state]);

  const copyTargetIds = useCallback(() => {
    if (!state) return [];
    if (viewMode === "canvas") {
      if (previewId && currentCanvasIds.has(previewId)) return [previewId];
      return selectedIds.filter((id) => currentCanvasIds.has(id));
    }
    if (viewMode === "library") {
      if (previewId && libraryImageIds.has(previewId)) return [previewId];
      return selectedIds.filter((id) => libraryImageIds.has(id));
    }
    return [];
  }, [currentCanvasIds, libraryImageIds, previewId, selectedIds, state, viewMode]);

  const deleteTargetIds = useCallback((key: "Delete" | "Backspace") => {
    if (viewMode !== "canvas") return [];
    if (previewId && currentCanvasIds.has(previewId)) return [previewId];
    if (key === "Delete" && hoveredId && currentCanvasIds.has(hoveredId)) return [hoveredId];
    return selectedIds.filter((id) => currentCanvasIds.has(id));
  }, [currentCanvasIds, hoveredId, previewId, selectedIds, viewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (dialogOpen) return;
      if (!panelVisible || isEditableTarget(target) || target?.closest("input, textarea, select, [contenteditable=true], .dialog-card")) return;
      // The preview modal owns Escape; other global shortcuts (for example
      // copying or removing the current preview) remain available.
      if ((previewId || document.querySelector(".quick-actions")) && event.key === "Escape") return;
      if (event.key === "Escape") {
        if (previewId || selectedIds.length > 0 || hoveredId) {
          event.preventDefault();
          clearInteraction();
        }
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const targetIds = copyTargetIds();
      if (modifier && event.key.toLowerCase() === "c" && targetIds.length > 0) {
        event.preventDefault();
        void copyFiles(targetIds);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && viewMode === "canvas" && !event.repeat) {
        const deleteIds = deleteTargetIds(event.key as "Delete" | "Backspace");
        if (deleteIds.length > 0) {
          event.preventDefault();
          void removeFromCanvas(deleteIds);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearInteraction, copyFiles, copyTargetIds, deleteTargetIds, dialogOpen, hoveredId, panelVisible, previewId, removeFromCanvas, selectedIds.length, viewMode]);

  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.items).some((item) => item.kind === "file") || event.dataTransfer.files.length > 0 || Array.from(event.dataTransfer.types).includes("Files");
  const handleDragEnter = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
    if (intakeStateRef.current === "idle") pushIntake("over");
  };
  const handleDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
    if (intakeStateRef.current === "idle") pushIntake("over");
  };
  const handleDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropActive(false);
      if (intakeStateRef.current === "over") pushIntake("idle");
    }
  };

  const handleImport = async (files: FileList | File[]): Promise<boolean> => {
    if (!state?.activeCanvasId) { showError("当前没有可用画布"); return false; }
    if (busy) { showError("正在处理，请稍候"); return false; }
    const accepted = Array.from(files).filter((file) => file.type.startsWith("image/") || ACCEPTED_EXTENSIONS.test(file.name));
    if (accepted.length === 0) { showError("没有识别到图片文件"); pushIntake("error", 1600); return false; }
    const element = viewportRef.current;
    const viewport: ImportViewport = { x: worldOffset.x, y: worldOffset.y, zoom, width: element?.clientWidth ?? 640, height: element?.clientHeight ?? 480 };
    const seq = importSeqRef.current += 1;
    setIntakeCount(accepted.length);
    pushIntake("receiving");
    markBusy();
    try {
      const payload = await Promise.all(accepted.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
      const next = await window.imageBoard.importImages(state.activeCanvasId, payload, viewport);
      if (seq !== importSeqRef.current) return true;
      applyState(next);
      pushIntake("success", Math.max(1000, 700 / ballSettings.speed + 500));
      showNotice(`已导入 ${accepted.length} 张图片`);
      return true;
    } catch (caught) {
      if (seq === importSeqRef.current) pushIntake("error", 1600);
      showError(caught instanceof Error ? caught.message : "导入失败");
      return false;
    } finally {
      if (seq === importSeqRef.current) markIdle();
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    await handleImport(event.dataTransfer.files);
  };

  const panelAnchorFor = (element: HTMLElement): PanelAnchor | null => {
    const shell = appShellRef.current?.getBoundingClientRect();
    if (!shell) return null;
    const card = element.getBoundingClientRect();
    const width = 240;
    const gap = 10;
    const rightFits = card.right - shell.left + gap + width <= shell.width - 12;
    const leftFits = card.left - shell.left - gap - width >= 12;
    let left = rightFits ? card.right - shell.left + gap : leftFits ? card.left - shell.left - gap - width : Math.max(12, (shell.width - width) / 2);
    const estimatedHeight = 230;
    let top = card.top - shell.top;
    if (!rightFits && !leftFits) top = card.bottom - shell.top + gap;
    return { left: Math.round(Math.max(12, Math.min(left, shell.width - width - 12))), top: Math.round(Math.max(12, Math.min(top, shell.height - estimatedHeight - 12))) };
  };

  const selectImage = (event: React.MouseEvent<HTMLElement> | null, imageId: string, toggleSelection = Boolean(event?.shiftKey)) => {
    event?.stopPropagation();
    const source = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const anchor = source ? panelAnchorFor(source) : null;
    setQuickActionsSource(source);
    setSelectedIds((current) => {
      const next = applySelection(current, imageId, toggleSelection);
      if (next.length === 0) setSelectionAnchor(null); else setSelectionAnchor(anchor);
      previewIdRef.current = null;
      setPreviewId(null);
      return next;
    });
  };

  const openPreview = (imageId: string) => {
    setActionsOpen(false);
    previewIdRef.current = imageId;
    setPreviewId(imageId);
    setSelectedIds([]);
    setSelectionAnchor(null);
  };

  const openQuickActions = (event: React.MouseEvent<HTMLElement> | null, imageId: string) => {
    event?.preventDefault();
    event?.stopPropagation();
    const source = event?.currentTarget ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const card = source?.closest<HTMLElement>(".image-card, .library-card") ?? source;
    const previousCard = quickActionsSource?.closest<HTMLElement>(".image-card, .library-card") ?? quickActionsSource;
    if (event?.type === "click" && actionsOpen && card === previousCard) { setActionsOpen(false); return; }
    setActionsOpen(true);
    setQuickActionsSource(source);
    if (!selectedIds.includes(imageId)) setSelectedIds([imageId]);
    previewIdRef.current = null;
    setPreviewId(null);
    setSelectionAnchor(source ? panelAnchorFor(source) : null);
  };

  const persistViewport = async (nextOffset: { x: number; y: number }, nextZoom: number) => {
    if (!state?.activeCanvasId) return;
    setWorldOffset(nextOffset); setZoom(nextZoom);
    try { applyState(await window.imageBoard.setCanvasViewport(state.activeCanvasId, { x: nextOffset.x, y: nextOffset.y, zoom: nextZoom })); }
    catch (caught) { showError(caught instanceof Error ? caught.message : "视角保存失败"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  };

  const zoomBy = (delta: number) => {
    const nextZoom = Math.min(1.5, Math.max(0.5, Number((zoom + delta).toFixed(1))));
    if (nextZoom === zoom) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    const centerX = rect ? rect.width / 2 : 320;
    const centerY = rect ? rect.height / 2 : 240;
    void persistViewport({ x: centerX - ((centerX - worldOffset.x) / zoom) * nextZoom, y: centerY - ((centerY - worldOffset.y) / zoom) * nextZoom }, nextZoom);
  };

  const locateAll = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || canvasImages.length === 0) { showInfo("当前画布还没有图片"); return; }
    const minX = Math.min(...canvasImages.map((image) => image.x));
    const minY = Math.min(...canvasImages.map((image) => image.y));
    const maxX = Math.max(...canvasImages.map((image) => image.x + image.width));
    const maxY = Math.max(...canvasImages.map((image) => image.y + image.height));
    const nextZoom = Math.min(1.5, Math.max(0.5, Math.min((rect.width - 72) / Math.max(1, maxX - minX), (rect.height - 72) / Math.max(1, maxY - minY))));
    const contentCenterX = (minX + maxX) / 2; const contentCenterY = (minY + maxY) / 2;
    void persistViewport({ x: rect.width / 2 - contentCenterX * nextZoom, y: rect.height / 2 - contentCenterY * nextZoom }, Number(nextZoom.toFixed(2)));
  };

  // Mini-map: live pan updates only local display; commit happens on release.
  const previewViewport = useCallback((nextOffset: { x: number; y: number }) => {
    setWorldOffset(nextOffset);
  }, []);
  const commitViewport = useCallback((nextOffset: { x: number; y: number }) => {
    void persistViewport(nextOffset, zoomRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistViewport]);
  useEffect(() => {
    let active = true;
    void window.imageBoard.isMaximized().then((value) => { if (active) setMaximized(value); }).catch(() => {});
    return () => { active = false; };
  }, [panelVisible]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvasId = state?.activeCanvasId;
    if (!viewport || !canvasId || viewMode !== "canvas" || !panelVisible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: CanvasViewport | null = null;
    const flush = () => {
      if (!pending) return;
      const next = pending;
      pending = null;
      void window.imageBoard.setCanvasViewport(canvasId, next).catch((caught) => showError(caught instanceof Error ? caught.message : "视角保存失败"));
    };
    const wheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector(".preview-backdrop, .dialog-card") || target?.closest(".quick-actions, .mini-map, input, textarea, select")) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const oldZoom = zoomRef.current;
      const nextZoom = Math.max(0.5, Math.min(1.5, oldZoom * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0015)));
      if (nextZoom === oldZoom) return;
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const oldOffset = worldOffsetRef.current;
      const nextOffset = { x: point.x - (point.x - oldOffset.x) * nextZoom / oldZoom, y: point.y - (point.y - oldOffset.y) * nextZoom / oldZoom };
      zoomRef.current = nextZoom;
      worldOffsetRef.current = nextOffset;
      setZoom(nextZoom); setWorldOffset(nextOffset);
      pending = { ...nextOffset, zoom: nextZoom };
      clearTimeout(timer);
      timer = setTimeout(flush, 180);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => { viewport.removeEventListener("wheel", wheel); clearTimeout(timer); flush(); };
  }, [state?.activeCanvasId, viewMode, panelVisible, showError]);

  const canvasPoint = (event: React.PointerEvent) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? { x: (event.clientX - rect.left - worldOffset.x) / zoom, y: (event.clientY - rect.top - worldOffset.y) / zoom } : { x: 0, y: 0 };
  };
  const startPan = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".quick-actions, .mini-map") || target.closest("button")) return;
    const imageTarget = target.closest<HTMLElement>(".image-card");
    const shouldPan = event.button === 1 || (event.button === 0 && spacePressedRef.current);
    // Normal left clicks on a card belong to the card. Capture is used so the
    // pan gesture can still begin on a card without stealing its click gesture.
    if (imageTarget && !shouldPan) return;
    if (shouldPan) {
      event.preventDefault();
      event.stopPropagation();
      panRef.current = { x: event.clientX, y: event.clientY, ox: worldOffset.x, oy: worldOffset.y, pointerId: event.pointerId };
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event);
    selectionRef.current = { start: point, additive: event.shiftKey, pointerId: event.pointerId };
    selectionRectRef.current = { x: point.x, y: point.y, width: 0, height: 0 };
    setSelectionRect(selectionRectRef.current);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const movePan = (event: React.PointerEvent) => {
    if (panRef.current?.pointerId === event.pointerId) {
      setWorldOffset({ x: panRef.current.ox + event.clientX - panRef.current.x, y: panRef.current.oy + event.clientY - panRef.current.y });
      return;
    }
    if (selectionRef.current?.pointerId === event.pointerId) {
      const nextRect = normalizeSelectionRect(selectionRef.current.start, canvasPoint(event));
      selectionRectRef.current = nextRect;
      setSelectionRect(nextRect);
    }
  };
  const stopPan = (event?: React.PointerEvent) => {
    if (panRef.current && (!event || panRef.current.pointerId === event.pointerId)) {
      const next = worldOffsetRef.current; panRef.current = null;
      if (event && viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
      if (state?.activeCanvasId) void persistViewport(next, zoom);
      return;
    }
    if (selectionRef.current && (!event || selectionRef.current.pointerId === event.pointerId)) {
      const selection = selectionRef.current;
      const rect = selectionRectRef.current;
      selectionRef.current = null;
      selectionRectRef.current = null;
      setSelectionRect(null);
      if (event && viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
      if (rect && (rect.width > 3 || rect.height > 3)) {
        const nextIds = imagesInSelectionRect(canvasImages, rect);
        setSelectedIds((current) => mergeSelection(current, nextIds, selection.additive));
        previewIdRef.current = null;
        setPreviewId(null);
      } else if (!selection.additive) {
        setSelectedIds([]); setSelectionAnchor(null); previewIdRef.current = null; setPreviewId(null);
      }
    }
  };
  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.code === "Space" && !isEditableTarget(event.target)) { spacePressedRef.current = true; setSpacePressed(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") { spacePressedRef.current = false; setSpacePressed(false); } };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const openPrompt = (title: string, value = "") => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(".quick-actions, .preview-card") : null;
    const anchor = origin ? panelAnchorFor(origin) : null;
    return new Promise<string | null>((resolve) => setDialog({ kind: "prompt", title, value, resolve, anchor }));
  };
  const openConfirm = (title: string, message: string) => new Promise<boolean>((resolve) => setDialog({ kind: "confirm", title, message, resolve }));
  const renameImage = async (image: ImageRecord) => {
    const name = await openPrompt("重命名图片", image.fileName);
    if (name === null || !name.trim()) return;
    markBusy("正在重命名…");
    try { applyState(await window.imageBoard.renameImage(image.id, name.trim())); showNotice("图片已重命名"); }
    catch (caught) { showError(caught instanceof Error ? caught.message : "重命名失败"); }
    finally { markIdle(); }
  };
  const deleteClassifiedImages = async (ids: string[]) => {
    if (!state || ids.length === 0 || deleteBusyRef.current || ids.some((id) => state.images[id]?.status !== "classified")) return;
    deleteBusyRef.current = true;
    try {
      const confirmed = await openConfirm("删除分类图片？", `将把 ${ids.length} 张已分类图片及其库文件发送到 Windows 系统回收站，可在系统回收站恢复；恢复文件不会自动恢复 PicBoard 索引。`);
      if (!confirmed) return;
      markBusy("正在删除分类图片…");
      try { applyState(await window.imageBoard.deleteClassifiedImages(ids)); clearInteraction(); showNotice(`已删除 ${ids.length} 张分类图片`); }
      catch (caught) { showError(caught instanceof Error ? caught.message : "删除分类图片失败"); }
      finally { markIdle(); }
    } finally {
      deleteBusyRef.current = false;
    }
  };
  const changeCanvas = async (canvasId: string) => { if (canvasId === state?.activeCanvasId || busy) return; clearInteraction(); markBusy(); try { applyState(await window.imageBoard.setActiveCanvas(canvasId)); } catch (caught) { showError(caught instanceof Error ? caught.message : "切换画布失败"); } finally { markIdle(); } };
  const rename = async () => { if (!activeCanvas) return; const name = await openPrompt("重命名画布", activeCanvas.name); if (name !== null) void update(() => window.imageBoard.renameCanvas(activeCanvas.id, name)); };
  const removeCanvas = async () => { if (!activeCanvas) return; const confirmed = await openConfirm(`删除“${activeCanvas.name}”？`, "未分类图片及其临时文件会被删除，此操作不可撤销。已分类图片及其库文件会保留。"); if (confirmed) { clearInteraction(); void update(() => window.imageBoard.deleteCanvas(activeCanvas.id)); } };
  const switchView = (next: ViewMode) => { setViewMode(next); clearInteraction(); setShowControls(false); };

  if (!state) return <div className="loading-card">{loadError ? <><strong>本地图片画布打开失败</strong><span>{loadError}</span><div className="loading-actions"><button className="primary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重试</button><button onClick={() => void window.imageBoard.closeWindow()}>退出</button></div></> : "正在打开本地图片画布…"}</div>;

  if (phase === "collapsed" || phase === "opening") {
    return <CollapsedBall settings={ballSettings} count={canvasImages.length} intakeState={intake.state} intakeKey={intake.key} intakeCount={intakeCount} dropActive={dropActive} failureLabel={failureLabel} onOpen={() => requestExpand(true)} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} />;
  }

  return <main ref={appShellRef} className={`app-shell ${phase === "closing" ? "closing" : ""} ${dropActive ? "drop-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    <header className="topbar"><div className="window-drag-region" onPointerDown={(event) => { if (event.button !== 0) return; titleDragRef.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={titleDragMove} onPointerUp={() => { titleDragRef.current = null; }} onPointerCancel={() => { titleDragRef.current = null; }} onLostPointerCapture={() => { titleDragRef.current = null; }}><div className="brand-mark"><IntakeBall settings={ballSettings} variant="brand" /></div><div className="brand-copy"><strong>PicBoard</strong><span>{viewMode === "settings" ? "外观、路径与窗口行为" : "本地临时整理区"}</span></div></div><div className="topbar-actions"><button className={viewMode === "canvas" ? "topbar-tab active" : "topbar-tab"} onClick={() => switchView("canvas")}>画布</button><button className={viewMode === "library" ? "topbar-tab active" : "topbar-tab"} onClick={() => switchView("library")}>分类库</button><button className={`icon-button no-drag settings-button ${viewMode === "settings" ? "active" : ""}`} aria-label="打开设置" title="打开设置" onClick={() => switchView("settings")}><IconGear size={15} /></button>{viewMode === "canvas" && <button className={`icon-button no-drag tool-toggle ${showControls ? "active" : ""}`} aria-label={showControls ? "收起画布工具" : "展开画布工具"} title={showControls ? "收起画布工具" : "展开画布工具"} onClick={() => setShowControls((visible) => !visible)}><IconDots size={16} /></button>}<button className="icon-button no-drag" aria-label={maximized ? "还原小窗" : "最大化窗口"} title={maximized ? "还原小窗" : "最大化窗口"} onClick={() => void toggleMaximize()}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">{maximized ? <><path d="M5 5V2h9v9h-3" /><rect x="2" y="5" width="9" height="9" rx="1" /></> : <rect x="2.5" y="2.5" width="11" height="11" rx="1" />}</svg></button><button className="icon-button no-drag" aria-label="收起画板" title="收起画板" onClick={() => requestExpand(false)}><IconMinus size={15} /></button><button className="icon-button no-drag close-window" aria-label="关闭（按设置处理）" title="关闭（按设置处理）" onClick={() => void window.imageBoard.closeWindow()}><IconClose size={15} /></button></div>{busy && <span className="busy-chip" role="status"><span className="busy-chip-dot" aria-hidden="true" />{busyLabel ?? "正在处理…"}</span>}</header>
    {viewMode === "canvas" ? <>
      {showControls && <div className="canvas-controls"><div className="canvas-tabs">{state.canvases.map((canvas) => <button key={canvas.id} className={canvas.id === state.activeCanvasId ? "canvas-tab active" : "canvas-tab"} onClick={() => void changeCanvas(canvas.id)}>{canvas.name}<small>{canvas.imageIds.length}</small></button>)}<button className="add-canvas" onClick={() => { clearInteraction(); void update(() => window.imageBoard.createCanvas()); }}>＋ 新画布</button></div><div className="canvas-toolbar"><span className="toolbar-label">{activeCanvas?.name ?? "当前画布"}</span><span className="toolbar-hint">左键预览 · Shift 多选 · 右键快捷操作 · 空白拖框选 · 中键/Space 平移</span><div className="zoom-controls"><button title="缩小" aria-label="缩小" onClick={() => zoomBy(-0.1)}>−</button><span>{Math.round(zoom * 100)}%</span><button title="放大" aria-label="放大" onClick={() => zoomBy(0.1)}>＋</button><button className="locate-button" title="定位全部图片" onClick={locateAll}>定位全部</button></div></div></div>}
      <div ref={viewportRef} className={`canvas-viewport ${dropActive ? "drop-active" : ""} ${spacePressed ? "hand-tool" : ""}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan} onLostPointerCapture={stopPan} onContextMenu={(event) => event.preventDefault()}><div className="canvas-world" style={{ transform: `translate(${worldOffset.x}px, ${worldOffset.y}px) scale(${zoom})` }}>{canvasImages.map((image) => <CanvasImage key={image.id} image={image} zoom={zoom} selected={selectedIds.includes(image.id)} selectedIds={selectedIds} onSelect={selectImage} onPreview={openPreview} onQuickActions={openQuickActions} spacePressed={spacePressed} onHover={setHoveredId} onMove={(id, x, y) => void update(() => window.imageBoard.moveImage(id, x, y))} />)}</div>{selectionRect && <div className="selection-rect" style={{ left: `${selectionRect.x * zoom + worldOffset.x}px`, top: `${selectionRect.y * zoom + worldOffset.y}px`, width: `${selectionRect.width * zoom}px`, height: `${selectionRect.height * zoom}px` }} />}{canvasImages.length === 0 && <div className="empty-canvas"><div className="empty-icon">↘</div><strong>把图片拖到悬浮窗</strong><span>或点击后使用 Ctrl+V 粘贴到当前画布</span></div>}{canvasImages.length > 0 && <MiniMap images={canvasImages} viewportRef={viewportRef} worldOffset={worldOffset} zoom={zoom} onPreview={previewViewport} onCommit={commitViewport} />}</div>
      {showControls && activeCanvas && <div className="footer-actions"><button onClick={() => void rename()}>重命名画布</button><button className="danger-link" onClick={() => void removeCanvas()}>删除画布</button></div>}
    </> : viewMode === "library" ? <Library state={state} selectedIds={selectedIds} onPreview={openPreview} onSelect={selectImage} onQuickActions={openQuickActions} onCopy={(ids) => void copyFiles(ids)} onRename={(image) => void renameImage(image)} onDelete={(ids) => void deleteClassifiedImages(ids)} /> : <SettingsPage state={state} ballSettings={ballSettings} pathSettings={pathSettings} onBallSettingsChange={(patch) => setBallSettings((current) => ({ ...current, ...patch }))} onPathSettingsChange={(patch) => setPathSettings((current) => ({ ...current, ...patch }))} onResetBall={() => setBallSettings({ ...DEFAULT_BALL_SETTINGS })} onAddCategory={async () => { const name = await openPrompt("新建分类"); if (!name) return false; return update(() => window.imageBoard.createCategory(name)); }} />}
    {!actionsOpen && !previewId && selectedIds.length > 0 && <div className="selection-toolbar"><span>已选 {selectedIds.length} 张</span><button onClick={() => { const target = document.querySelector<HTMLElement>(".image-card.selected, .library-card.selected"); if (target) { setQuickActionsSource(target); setActionsOpen(true); } }}>操作</button><button onClick={clearInteraction}>取消选择</button></div>}
    {actionsOpen && selectedIds.length > 0 && viewMode === "canvas" && <QuickActions state={state} selectedIds={selectedIds} source={quickActionsSource} anchor={selectionAnchor} showRemove={true} onClose={() => setActionsOpen(false)} onUpdate={applyState} onError={showError} onNotice={showNotice} onCopy={copyFiles} onPrompt={openPrompt} onRename={(image) => void renameImage(image)} onDelete={(ids) => void deleteClassifiedImages(ids)} />}
    {actionsOpen && selectedIds.length > 0 && viewMode === "library" && <QuickActions state={state} selectedIds={selectedIds} source={quickActionsSource} anchor={selectionAnchor} showRemove={false} onClose={() => setActionsOpen(false)} onUpdate={applyState} onError={showError} onNotice={showNotice} onCopy={copyFiles} onPrompt={openPrompt} onRename={(image) => void renameImage(image)} onDelete={(ids) => void deleteClassifiedImages(ids)} />}
    {previewImage && <QuickPreview image={previewImage} onClose={() => { setActionsOpen(false); previewIdRef.current = null; setPreviewId(null); setHoveredId(null); }} onClassify={(origin) => { setSelectedIds([previewImage.id]); setQuickActionsSource(origin); setActionsOpen((open) => !open); setSelectionAnchor(panelAnchorFor(origin)); }} onCopy={() => void copyFiles([previewImage.id])} onRename={(image) => void renameImage(image)} onDelete={(ids) => void deleteClassifiedImages(ids)} />}
    <ToastView toast={toast} onClose={clearToast} />
    {dialog && <Dialog dialog={dialog} onClose={clearDialog} />}
  </main>;
}

function CollapsedBall({ settings, count, intakeState, intakeKey, intakeCount, dropActive, failureLabel, onOpen, onDragEnter, onDragOver, onDragLeave, onDrop }: { settings: BallSettings; count: number; intakeState: IntakeState; intakeKey: number; intakeCount: number; dropActive: boolean; failureLabel: string; onOpen: () => void; onDragEnter: (event: React.DragEvent) => void; onDragOver: (event: React.DragEvent) => void; onDragLeave: (event: React.DragEvent) => void; onDrop: (event: React.DragEvent) => void }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activePointerRef = useRef<number | "mouse" | null>(null);
  const holdPointRef = useRef({ x: 0, y: 0 });
  const dragStartedRef = useRef(false);
  const onOpenRef = useRef(onOpen);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  const clearTimer = useCallback(() => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = null; }, []);
  const dragCommandRef = useRef<Promise<void>>(Promise.resolve());
  const queueDragCommand = useCallback((command: () => Promise<void>) => {
    const next = dragCommandRef.current.catch(() => undefined).then(command);
    dragCommandRef.current = next.catch(() => undefined);
    return next;
  }, []);
  const finish = useCallback((shouldOpen: boolean) => {
    clearTimer();
    const wasDragging = dragStartedRef.current;
    const pointerId = activePointerRef.current;
    const hadCapture = typeof pointerId === "number" && shellRef.current?.hasPointerCapture(pointerId);
    activePointerRef.current = null;
    dragStartedRef.current = false;
    setDragging(false);
    if (wasDragging) void queueDragCommand(() => window.imageBoard.endWindowDrag());
    if (hadCapture && typeof pointerId === "number") shellRef.current?.releasePointerCapture(pointerId);
    if (shouldOpen && !wasDragging) onOpenRef.current();
  }, [clearTimer, queueDragCommand]);
  useEffect(() => {
    const cancelIfHidden = () => { if (document.visibilityState === "hidden") finish(false); };
    const cancelOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") finish(false); };
    const finishOnPointerUp = (event: PointerEvent) => { if (typeof activePointerRef.current === "number" && activePointerRef.current === event.pointerId) finish(true); };
    const finishOnMouseUp = () => { if (activePointerRef.current === "mouse") finish(true); };
    document.addEventListener("visibilitychange", cancelIfHidden);
    window.addEventListener("keydown", cancelOnKey);
    window.addEventListener("pointerup", finishOnPointerUp, true);
    window.addEventListener("mouseup", finishOnMouseUp, true);
    return () => { document.removeEventListener("visibilitychange", cancelIfHidden); window.removeEventListener("keydown", cancelOnKey); window.removeEventListener("pointerup", finishOnPointerUp, true); window.removeEventListener("mouseup", finishOnMouseUp, true); finish(false); };
  }, [finish]);
  const beginHold = useCallback((pointerId: number | "mouse", event?: { clientX: number; clientY: number; preventDefault: () => void }) => {
    if (activePointerRef.current !== null) return;
    event?.preventDefault();
    holdPointRef.current = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 };
    activePointerRef.current = pointerId;
    dragStartedRef.current = false;
    if (typeof pointerId === "number") shellRef.current?.setPointerCapture(pointerId);
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (activePointerRef.current !== pointerId || document.visibilityState === "hidden") return;
      dragStartedRef.current = true;
      setDragging(true);
      void queueDragCommand(() => window.imageBoard.startWindowDrag());
    }, 250);
  }, [clearTimer]);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => { if (event.button === 0) beginHold(event.pointerId, event); };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current && Math.hypot(event.clientX - holdPointRef.current.x, event.clientY - holdPointRef.current.y) >= 6) { clearTimer(); dragStartedRef.current = true; setDragging(true); void queueDragCommand(() => window.imageBoard.startWindowDrag()); } };
  const mouseDown = (event: React.MouseEvent<HTMLDivElement>) => { if (event.button === 0 && activePointerRef.current === null) beginHold("mouse", event); };
  const mouseMove = (event: React.MouseEvent<HTMLDivElement>) => { if (activePointerRef.current === "mouse" && !dragStartedRef.current && Math.hypot(event.clientX - holdPointRef.current.x, event.clientY - holdPointRef.current.y) >= 6) { clearTimer(); dragStartedRef.current = true; setDragging(true); void queueDragCommand(() => window.imageBoard.startWindowDrag()); } };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId) finish(true); };
  const mouseUp = () => { if (activePointerRef.current === "mouse") finish(true); };
  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current) finish(false); };
  const lostPointerCapture = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current) finish(false); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (dragStartedRef.current || activePointerRef.current !== null) return;
    event.preventDefault();
    onOpenRef.current();
  };

  const countLabel = count > 99 ? "99+" : String(count);
  const showCount = count > 0 && intakeState !== "success" && intakeState !== "error";
  const showBadge = intakeState === "success" || intakeState === "error";
  const describeState = intakeState === "receiving" ? "正在接收图片" : intakeState === "success" ? `已接收 ${intakeCount} 张图片` : intakeState === "error" ? "接收失败" : `${count} 张图片`;
  const description = failureLabel ? `${failureLabel}。${describeState}。短点展开，长按拖动` : `${describeState}。短点展开，长按拖动`;

  return <div ref={shellRef} role="button" tabIndex={0} aria-label={description} title={description} aria-haspopup="dialog" className={`collapsed-shell ${dragging ? "dragging" : ""} ${dropActive ? "drop-active" : ""}`} onKeyDown={onKeyDown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={lostPointerCapture} onMouseDown={mouseDown} onMouseMove={mouseMove} onMouseUp={mouseUp} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <div className="collapsed-ball">
      <IntakeBall settings={settings} intakeState={intakeState} intakeKey={intakeKey} intakeCount={intakeCount} variant="ball" />
      {showCount && <span className="collapsed-count" title={`画布中有 ${count} 张图片`}>{countLabel}</span>}
      {showBadge && <span className={`intake-badge ${intakeState}`} aria-hidden="true">{intakeState === "success"
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 12.6l4.6 4.6 9.8-9.8" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.4v7" /><circle cx="12" cy="17.1" r="1" /></svg>}</span>}
    </div>
  </div>;
}

function MiniMap({ images, viewportRef, worldOffset, zoom, onPreview, onCommit }: { images: ImageRecord[]; viewportRef: React.RefObject<HTMLDivElement>; worldOffset: { x: number; y: number }; zoom: number; onPreview: (next: { x: number; y: number }) => void; onCommit: (next: { x: number; y: number }) => void }) {
  const width = 164;
  const height = 104;
  const [dragging, setDragging] = useState(false);
  const geometry = useMemo(() => {
    const element = viewportRef.current;
    return createMiniMapGeometry(images, { x: worldOffset.x, y: worldOffset.y, width: element?.clientWidth ?? 640, height: element?.clientHeight ?? 480, zoom }, width, height);
  }, [images, viewportRef, worldOffset.x, worldOffset.y, zoom]);
  const mapRef = useRef<HTMLDivElement>(null);
  const navigate = (event: React.PointerEvent) => {
    const rect = mapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const point = miniMapToWorld(geometry, event.clientX - rect.left, event.clientY - rect.top);
    const element = viewportRef.current;
    const viewWidth = element?.clientWidth ?? 640;
    const viewHeight = element?.clientHeight ?? 480;
    onPreview({ x: viewWidth / 2 - point.x * zoom, y: viewHeight / 2 - point.y * zoom });
  };
  const pointerDown = (event: React.PointerEvent) => { event.stopPropagation(); setDragging(true); mapRef.current?.setPointerCapture(event.pointerId); navigate(event); };
  const pointerMove = (event: React.PointerEvent) => { if (dragging) navigate(event); };
  const pointerUp = (event: React.PointerEvent) => {
    setDragging(false);
    if (mapRef.current?.hasPointerCapture(event.pointerId)) mapRef.current.releasePointerCapture(event.pointerId);
    const rect = mapRef.current?.getBoundingClientRect();
    if (rect) {
      const point = miniMapToWorld(geometry, event.clientX - rect.left, event.clientY - rect.top);
      const element = viewportRef.current;
      const viewWidth = element?.clientWidth ?? 640;
      const viewHeight = element?.clientHeight ?? 480;
      onCommit({ x: viewWidth / 2 - point.x * zoom, y: viewHeight / 2 - point.y * zoom });
    }
  };
  return <div ref={mapRef} className={`mini-map ${dragging ? "dragging" : ""}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => setDragging(false)} onClick={(event) => event.stopPropagation()} aria-label="画布小地图"><svg viewBox={`0 0 ${width} ${height}`} role="img"><rect className="mini-map-bg" x="0" y="0" width={width} height={height} rx="10" />{geometry.images.map((image) => <rect key={image.id} className="mini-map-image" x={image.x} y={image.y} width={image.width} height={image.height} rx="2" />)}<rect className="mini-map-viewport" x={geometry.viewport.x} y={geometry.viewport.y} width={geometry.viewport.width} height={geometry.viewport.height} rx="3" /></svg></div>;
}

function SettingsPage({ state, ballSettings, pathSettings, onBallSettingsChange, onPathSettingsChange, onResetBall, onAddCategory }: { state: AppState; ballSettings: BallSettings; pathSettings: PathSettings; onBallSettingsChange: (patch: Partial<BallSettings>) => void; onPathSettingsChange: (patch: Partial<PathSettings>) => void; onResetBall: () => void; onAddCategory: () => Promise<boolean> }) {
  const shapeOptions = SHAPES.map((shape) => ({ value: shape.id, label: SHAPE_LABELS[shape.id] ?? shape.id }));
  return <section className="settings-view"><div className="settings-heading"><div><h1>设置</h1><p>外观与动效、目录偏好和窗口行为都集中在这里，改动即时生效。</p></div><div className="settings-ball-preview"><IntakeBall settings={ballSettings} variant="preview" /></div></div>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>外观与动效</strong><span>颜色、形状与动效会在收纳态立即生效。</span></div><button className="text-button" onClick={onResetBall}>恢复默认</button></div><div className="settings-row"><div className="settings-field settings-field-wide"><label>主体颜色</label><div className="color-options">{COLORS.map((color) => <button key={color.id} className={`color-swatch ${ballSettings.colorId === color.id ? "selected" : ""}`} style={{ backgroundColor: color.hex }} title={color.id} aria-label={`选择${color.id}色`} aria-pressed={ballSettings.colorId === color.id} onClick={() => onBallSettingsChange({ colorId: color.id })} />)}</div></div><ColorPicker value={ballSettings.eyeColor} label="眼睛颜色" onChange={(hex) => onBallSettingsChange({ eyeColor: hex })} /></div><div className="settings-row"><Select value={ballSettings.shapeId} label="身体形状" options={shapeOptions} onChange={(value) => onBallSettingsChange({ shapeId: value })} /><Select value={ballSettings.animation} label="表情模式" options={ANIMATION_OPTIONS} onChange={(value) => onBallSettingsChange({ animation: value as BallSettings["animation"] })} /></div><div className="settings-row"><label className="range-field"><span><b>播放速度</b><output>{ballSettings.speed.toFixed(1)}×</output></span><input type="range" min="0.5" max="2" step="0.1" value={ballSettings.speed} onChange={(event) => onBallSettingsChange({ speed: Number(event.target.value) })} /></label><label className="range-field"><span><b>动效强度</b><output>{Math.round(ballSettings.motion * 100)}%</output></span><input type="range" min="0" max="1" step="0.05" value={ballSettings.motion} onChange={(event) => onBallSettingsChange({ motion: Number(event.target.value) })} /></label></div><label className="settings-toggle"><input type="checkbox" checked={ballSettings.followGaze} onChange={(event) => onBallSettingsChange({ followGaze: event.target.checked })} /><span><b>跟随指针</b><small>指针靠近小球时，眼睛会跟着看。</small></span></label></section>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>目录偏好</strong><span>只保存路径偏好，不会自动搬运或删除已有图片。</span></div></div><div className="path-fields"><DirectoryField label="文件路径" value={pathSettings.filePath} onChange={(value) => onPathSettingsChange({ filePath: value })} /><DirectoryField label="分类图片路径" value={pathSettings.classifiedPath} onChange={(value) => onPathSettingsChange({ classifiedPath: value })} /><DirectoryField label="画布临时路径" value={pathSettings.temporaryPath} onChange={(value) => onPathSettingsChange({ temporaryPath: value })} /></div><p className="settings-note">路径变更不会在当前版本执行迁移；现有数据仍由应用的本地存储目录保护。</p></section>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>窗口与启动</strong><span>关闭行为与开机自启动。</span></div></div><ShellSettings /></section>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>分类类别</strong><span>分类会直接写入当前本地图片库。</span></div><button className="primary-button small-button" onClick={() => void onAddCategory()}>＋ 新建分类</button></div><div className="category-list">{state.categories.map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}</div></section>
  </section>;
}

function CanvasImage({ image, zoom, selected, selectedIds, spacePressed, onSelect, onPreview, onQuickActions, onHover, onMove }: { image: ImageRecord; zoom: number; selected: boolean; selectedIds: string[]; spacePressed: boolean; onSelect: (event: React.MouseEvent<HTMLElement> | null, id: string, toggleSelection?: boolean) => void; onPreview: (id: string) => void; onQuickActions: (event: React.MouseEvent<HTMLElement> | null, id: string) => void; onHover: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void }) {
  const nodeRef = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, left: image.x, top: image.y });
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const cancelFrame = () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  const restoreTransform = () => { cancelFrame(); if (nodeRef.current) nodeRef.current.style.transform = ""; };
  useEffect(() => () => cancelFrame(), []);
  const pointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button === 1) { event.preventDefault(); return; }
    if (event.button === 1 || (event.button === 0 && spacePressed)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    movedRef.current = false;
    suppressClickRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY, left: image.x, top: image.y };
    setPressed(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    const deltaX = (event.clientX - startRef.current.x) / zoom;
    const deltaY = (event.clientY - startRef.current.y) / zoom;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      if (!movedRef.current) {
        movedRef.current = true;
        setPressed(false);
        setDragging(true);
      }
    }
    const node = event.currentTarget;
    cancelFrame();
    rafRef.current = requestAnimationFrame(() => {
      node.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1.02)`;
      rafRef.current = null;
    });
  };
  const finish = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (activePointerRef.current !== event.pointerId) return;
    const moved = movedRef.current;
    const deltaX = (event.clientX - startRef.current.x) / zoom;
    const deltaY = (event.clientY - startRef.current.y) / zoom;
    activePointerRef.current = null;
    suppressClickRef.current = moved;
    movedRef.current = false;
    setPressed(false);
    setDragging(false);
    if (commit && moved) {
      const finalLeft = startRef.current.left + deltaX;
      const finalTop = startRef.current.top + deltaY;
      event.currentTarget.style.left = `${finalLeft}px`;
      event.currentTarget.style.top = `${finalTop}px`;
      restoreTransform();
      onMove(image.id, finalLeft, finalTop);
    } else {
      restoreTransform();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerUp = (event: React.PointerEvent<HTMLElement>) => finish(event, true);
  const pointerCancel = (event: React.PointerEvent<HTMLElement>) => finish(event, false);
  const lostPointerCapture = (event: React.PointerEvent<HTMLElement>) => finish(event, false);
  const contextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onQuickActions(event, image.id);
  };
  const keyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); onQuickActions(null, image.id); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (event.shiftKey) onSelect(null, image.id, true); else onPreview(image.id); }
  };
  const click = (event: React.MouseEvent<HTMLElement>) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; event.preventDefault(); return; }
    event.currentTarget.focus();
    if (event.shiftKey) onSelect(event, image.id, true); else onPreview(image.id);
  };

  return <article ref={nodeRef} role="button" tabIndex={0} aria-label={`图片 ${image.fileName}`} className={`image-card ${selected ? "selected" : ""} ${pressed ? "pressed" : ""} ${dragging ? "dragging" : ""}`} style={{ left: image.x, top: image.y }} onKeyDown={keyboard} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={lostPointerCapture} onMouseEnter={() => onHover(image.id)} onMouseLeave={() => onHover(null)} onClick={click} onContextMenu={contextMenu}>{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} draggable={false} /> : <div className="image-missing">预览不可用</div>}<div className="image-meta"><span className={image.status === "classified" ? "status-dot classified" : "status-dot"}></span><span title={image.fileName}>{image.fileName}</span></div></article>;
}

function QuickPreview({ image, onClose, onClassify, onCopy, onRename, onDelete }: { image: ImageRecord; onClose: () => void; onClassify: (origin: HTMLElement) => void; onCopy: () => void; onRename: (image: ImageRecord) => void; onDelete: (ids: string[]) => void }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const [baseSize, setBaseSize] = useState({ width: 1, height: 1 });
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; pointerId: number } | null>(null);
  const clamp = (nextOffset: { x: number; y: number }, nextZoom = zoom, size = baseSize) => {
    const wrap = wrapRef.current;
    if (!wrap) return nextOffset;
    return clampPreviewOffset(nextOffset, { width: wrap.clientWidth, height: wrap.clientHeight }, size, nextZoom);
  };
  useLayoutEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    closeRef.current?.focus();
    const card = cardRef.current;
    const focusable = () => Array.from(card?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => !element.hasAttribute("disabled"));
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (hasBlockingDialog() || document.querySelector(".quick-actions")) return;
        event.preventDefault(); event.stopPropagation(); onCloseRef.current(); return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      const target = previouslyFocusedRef.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const resize = () => {
      const natural = naturalSizeRef.current;
      const nextBaseSize = natural
        ? fitPreviewSize(natural, { width: wrap.clientWidth, height: wrap.clientHeight })
        : baseSize;
      if (natural) setBaseSize(nextBaseSize);
      setOffset((current) => clamp(current, zoom, nextBaseSize));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [baseSize, zoom]);
  useEffect(() => {
    setZoom(1); setOffset({ x: 0, y: 0 }); setBaseSize({ width: 1, height: 1 }); naturalSizeRef.current = null;
  }, [image.id]);
  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const nextZoom = clampPreviewZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    if (nextZoom === zoom) return;
    const wrap = wrapRef.current;
    const rect = wrap?.getBoundingClientRect();
    const point = rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
    const viewport = wrap ? { width: wrap.clientWidth, height: wrap.clientHeight } : { width: 0, height: 0 };
    const nextOffset = zoomAroundPoint(point, zoom, nextZoom, offsetRef.current, viewport);
    setOffset(clamp(nextOffset, nextZoom)); setZoom(nextZoom);
  };
  const pointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || zoom <= 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    setOffset(clamp({ x: dragRef.current.ox + event.clientX - dragRef.current.x, y: dragRef.current.oy + event.clientY - dragRef.current.y }));
  };
  const pointerUp = (event: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const lostPointerCapture = (event: React.PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  useEffect(() => () => { dragRef.current = null; }, []);
  return <div className="preview-backdrop" onMouseDown={onClose}><section ref={cardRef} className="preview-card" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => event.stopPropagation()}><div className="preview-header"><span>快速预览</span><button className="card-more" aria-label="图片操作" aria-expanded={false} onClick={(event) => onClassify(event.currentTarget)}>⋯</button><span className="preview-zoom">{Math.round(zoom * 100)}%</span><button ref={closeRef} className="close-button" onClick={onClose} aria-label="关闭预览" title="关闭预览"><IconClose size={14} /></button></div><div ref={wrapRef} className={`preview-image-wrap ${zoom > 1 ? "zoomed" : ""}`} onWheel={onWheel} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={lostPointerCapture}>{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} onLoad={(event) => { const natural = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; naturalSizeRef.current = natural; const wrap = wrapRef.current; const nextBaseSize = fitPreviewSize(natural, wrap ? { width: wrap.clientWidth, height: wrap.clientHeight } : natural); setBaseSize(nextBaseSize); setOffset((current) => clamp(current, zoom, nextBaseSize)); }} style={{ width: `${baseSize.width}px`, height: `${baseSize.height}px`, transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }} draggable={false} /> : <div className="image-missing">预览不可用</div>}</div><div className="preview-zoom-actions"><span>{Math.round(zoom * 100)}%</span><button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>重置</button></div><div className="preview-meta"><strong title={image.fileName}>{image.fileName}</strong><span>{image.status === "classified" ? "已归档图片" : "临时图片"}</span></div></section></div>;
}


function Library({ state, selectedIds, onPreview, onSelect, onQuickActions, onCopy, onRename, onDelete }: { state: AppState; selectedIds: string[]; onPreview: (id: string) => void; onSelect: (event: React.MouseEvent<HTMLElement> | null, id: string, toggleSelection?: boolean) => void; onQuickActions: (event: React.MouseEvent<HTMLElement> | null, id: string) => void; onCopy: (ids: string[]) => void; onRename: (image: ImageRecord) => void; onDelete: (ids: string[]) => void }) {
  const categorized = useMemo(() => Object.values(state.images).filter((image) => image.status === "classified"), [state.images]);
  const keyboard = (event: React.KeyboardEvent<HTMLElement>, image: ImageRecord) => { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); event.currentTarget.focus(); onQuickActions(null, image.id); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.focus(); if (event.shiftKey) onSelect(null, image.id, true); else onPreview(image.id); } };
  return <section className="library-view"><div className="library-heading"><div><strong>分类图片库</strong><span>左键预览 · Shift 多选 · 右键快捷操作</span></div><span>{categorized.length} 张</span></div>{state.categories.map((category) => { const images = categorized.filter((image) => image.categoryId === category.id); return <div className="library-group" key={category.id}><div className="library-group-title"><strong>{category.name}</strong><span>{images.length}</span></div>{images.length > 0 && <div className="library-grid">{images.map((image) => { const selected = selectedIds.includes(image.id); return <article className={`library-card ${selected ? "selected" : ""}`} key={image.id} role="button" tabIndex={0} aria-selected={selected} aria-label={`图片 ${image.fileName}`} onKeyDown={(event) => keyboard(event, image)} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, .quick-actions")) { if (event.shiftKey) onSelect(event, image.id, true); else onPreview(image.id); } }} onContextMenu={(event) => onQuickActions(event, image.id)}><div className="library-card-media">{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} /> : <div className="image-missing">预览不可用</div>}</div><span title={image.fileName}>{image.fileName}</span><button className="card-more" aria-expanded={false} onPointerDown={(event) => event.stopPropagation()} aria-label={`操作 ${image.fileName}`} onClick={(event) => { event.stopPropagation(); onQuickActions(event, image.id); }}>⋯</button></article>; })}</div>}</div>})}{categorized.length === 0 && <div className="library-empty">还没有已分类图片。回到画布后右键图片分类，或先粘贴图片。</div>}</section>;
}

function Dialog({ dialog, onClose }: { dialog: DialogState; onClose: () => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.value : "");
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
      return list.filter((el) => !el.hasAttribute("disabled"));
    };
    // Prompt: focus + select the text; confirm: focus the cancel button so
    // destructive actions are never the default target.
    if (dialog.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      cancelRef.current?.focus();
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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

  const finish = (result: string | null | boolean) => { dialog.resolve(result as never); onClose(); };
  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      finish(dialog.kind === "prompt" ? null : false);
    }
  };
  return <div className="dialog-backdrop" onMouseDown={() => finish(dialog.kind === "prompt" ? null : false)}><section ref={cardRef} className="dialog-card" style={position ? { position: "absolute", left: position.left, top: position.top } : undefined} role="alertdialog" aria-modal="true" aria-label={dialog.title} onKeyDown={handleKey} onMouseDown={(event) => event.stopPropagation()}><strong>{dialog.title}</strong>{dialog.kind === "prompt" ? <input ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") finish(value); if (event.key === "Escape") finish(null); }} /> : <p>{dialog.message}</p>}<div className="dialog-actions"><button ref={cancelRef} onClick={() => finish(dialog.kind === "prompt" ? null : false)}>取消</button><button className={dialog.kind === "confirm" ? "danger-button" : "primary-button"} onClick={() => finish(dialog.kind === "prompt" ? value : true)}>{dialog.kind === "confirm" ? "删除" : "确定"}</button></div></section></div>;
}

export default App;
