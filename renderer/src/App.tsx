import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, CanvasViewport, ImageRecord, ImportViewport } from "../../shared/image-board";
import { BloubBall } from "./BloubBall";
import { DEFAULT_BALL_SETTINGS, readBallSettings, saveBallSettings, type BallSettings } from "./ball-settings";
import { COLORS, SHAPES } from "./third-party/bloub/skins";
import { createMiniMapGeometry, miniMapToWorld } from "../../shared/minimap-geometry";

type ViewMode = "canvas" | "library" | "settings";
type DialogState = { kind: "prompt"; title: string; value: string; resolve: (value: string | null) => void } | { kind: "confirm"; title: string; message: string; resolve: (value: boolean) => void };
type PathSettings = { filePath: string; classifiedPath: string; temporaryPath: string };
type PanelAnchor = { left: number; top: number };
type DropFeedback = "success" | "error" | null;

const ACCEPTED_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DEFAULT_VIEWPORT: CanvasViewport = { x: -900, y: -500, zoom: 1 };
const PATH_SETTINGS_KEY = "quick-image-board.path-settings";
const DEFAULT_PATH_SETTINGS: PathSettings = { filePath: "quick-image-board", classifiedPath: "quick-image-board/classified", temporaryPath: "quick-image-board/pending" };

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

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [showControls, setShowControls] = useState(false);
  const [ballSettings, setBallSettings] = useState<BallSettings>(() => readBallSettings(window.localStorage));
  const [pathSettings, setPathSettings] = useState<PathSettings>(() => readPathSettings());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<PanelAnchor | null>(null);
  const [dropFeedback, setDropFeedback] = useState<DropFeedback>(null);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const dropFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom);
  const [worldOffset, setWorldOffset] = useState({ x: DEFAULT_VIEWPORT.x, y: DEFAULT_VIEWPORT.y });
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const appShellRef = useRef<HTMLElement>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const activeCanvas = state?.canvases.find((canvas) => canvas.id === state.activeCanvasId);
  const canvasImages = state && activeCanvas ? imageList(state, activeCanvas.id) : [];
  const previewImage = previewId && state?.images[previewId];

  const applyState = useCallback((next: AppState) => {
    setState(next);
    if (next.storageNotice) setNotice(next.storageNotice);
  }, []);

  const update = useCallback(async (operation: () => Promise<AppState>) => {
    try {
      setError("");
      applyState(await operation());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
      return false;
    }
  }, [applyState]);

  const clearInteraction = useCallback(() => {
    setSelectedIds([]);
    setPreviewId(null);
    setHoveredId(null);
    setSelectionAnchor(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void window.imageBoard.loadState().then((next) => {
      if (cancelled) return;
      applyState(next);
      if (next.storageNotice) setNotice(next.storageNotice);
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
    return () => {
      if (dropFeedbackTimerRef.current) clearTimeout(dropFeedbackTimerRef.current);
      dropFeedbackTimerRef.current = null;
      dragDepthRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const viewport = state?.canvases.find((canvas) => canvas.id === state.activeCanvasId)?.viewport ?? DEFAULT_VIEWPORT;
    setZoom(viewport.zoom);
    setWorldOffset({ x: viewport.x, y: viewport.y });
  }, [state?.activeCanvasId]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!expanded || busy || !state?.activeCanvasId || viewMode !== "canvas" || isEditableTarget(target) || target?.closest("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      setBusy(true);
      void window.imageBoard.pasteImage(state.activeCanvasId).then((result) => {
        applyState(result.state);
        setNotice(result.imported ? "图片已粘贴到当前画布" : "剪贴板中没有图片");
      }).catch((caught) => setError(caught instanceof Error ? caught.message : "粘贴失败")).finally(() => setBusy(false));
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [applyState, busy, expanded, state?.activeCanvasId, viewMode]);

  const currentCanvasIds = useMemo(() => new Set(canvasImages.map((image) => image.id)), [canvasImages]);
  const libraryImageIds = useMemo(() => new Set(Object.values(state?.images ?? {}).filter((image) => image.status === "classified").map((image) => image.id)), [state?.images]);

  const removeFromCanvas = useCallback(async (ids: string[]) => {
    if (!state || viewMode !== "canvas" || ids.length === 0 || busy) return;
    const targetIds = ids.filter((id) => currentCanvasIds.has(id));
    if (targetIds.length === 0) return;
    setBusy(true);
    try {
      let next = state;
      for (const id of targetIds) next = await window.imageBoard.removeImageFromCanvas(id);
      applyState(next);
      setSelectedIds((current) => current.filter((id) => !targetIds.includes(id)));
      setHoveredId((current) => current && targetIds.includes(current) ? null : current);
      setSelectionAnchor(null);
      setPreviewId((current) => current && targetIds.includes(current) ? null : current);
      setNotice(`已从画布移除 ${targetIds.length} 张图片`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "移除失败"); }
    finally { setBusy(false); }
  }, [applyState, busy, currentCanvasIds, state, viewMode]);

  const copyFiles = useCallback(async (ids: string[]) => {
    if (!state || ids.length === 0 || busy) return;
    const targetIds = ids.filter((id) => Boolean(state.images[id]));
    if (targetIds.length === 0) return;
    setBusy(true);
    setCopying(true);
    try {
      const result = await window.imageBoard.copyImageFiles(targetIds);
      setNotice(result.copied === targetIds.length && result.copied > 1 ? `已复制 ${result.copied} 个图片文件` : result.copied > 0 ? "已复制图片文件" : "没有复制图片文件");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "复制失败"); }
    finally { setCopying(false); setBusy(false); }
  }, [busy, state]);

  const copyTargetIds = useCallback(() => {
    if (!state) return [];
    if (viewMode === "canvas") {
      if (previewId && currentCanvasIds.has(previewId)) return [previewId];
      const selected = selectedIds.filter((id) => currentCanvasIds.has(id));
      if (selected.length > 1) return selected;
      if (hoveredId && currentCanvasIds.has(hoveredId)) return [hoveredId];
      if (selected.length === 1) return selected;
      return [];
    }
    if (viewMode === "library") {
      if (previewId && libraryImageIds.has(previewId)) return [previewId];
      const selected = selectedIds.filter((id) => libraryImageIds.has(id));
      if (selected.length > 0) return selected;
      return hoveredId && libraryImageIds.has(hoveredId) ? [hoveredId] : [];
    }
    return [];
  }, [currentCanvasIds, hoveredId, libraryImageIds, previewId, selectedIds, state, viewMode]);

  const deleteTargetIds = useCallback((key: "Delete" | "Backspace") => {
    if (viewMode !== "canvas") return [];
    if (previewId && currentCanvasIds.has(previewId)) return [previewId];
    if (key === "Delete" && hoveredId && currentCanvasIds.has(hoveredId)) return [hoveredId];
    return selectedIds.filter((id) => currentCanvasIds.has(id));
  }, [currentCanvasIds, hoveredId, previewId, selectedIds, viewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!expanded || dialog || isEditableTarget(target) || target?.closest("input, textarea, [contenteditable=true], .dialog-card")) return;
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
  }, [clearInteraction, copyFiles, copyTargetIds, deleteTargetIds, dialog, expanded, hoveredId, previewId, removeFromCanvas, selectedIds.length, viewMode]);

  const toggleExpanded = (next: boolean) => {
    setExpanded(next);
    if (!next) clearInteraction();
    void window.imageBoard.setExpanded(next).catch((caught) => setError(caught instanceof Error ? caught.message : "窗口调整失败"));
  };

  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.items).some((item) => item.kind === "file") || event.dataTransfer.files.length > 0 || Array.from(event.dataTransfer.types).includes("Files");
  const showDropFeedback = useCallback((feedback: Exclude<DropFeedback, null>) => {
    if (dropFeedbackTimerRef.current) clearTimeout(dropFeedbackTimerRef.current);
    setDropFeedback(feedback);
    dropFeedbackTimerRef.current = setTimeout(() => {
      setDropFeedback(null);
      dropFeedbackTimerRef.current = null;
    }, 1100);
  }, []);
  const handleDragEnter = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };
  const handleDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };
  const handleDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  const handleImport = async (files: FileList | File[]): Promise<boolean> => {
    if (!state?.activeCanvasId) { setError("当前没有可用画布"); return false; }
    if (busy) { setError("正在处理，请稍候"); return false; }
    const accepted = Array.from(files).filter((file) => file.type.startsWith("image/") || ACCEPTED_EXTENSIONS.test(file.name));
    if (accepted.length === 0) { setError("没有识别到图片文件"); return false; }
    const element = viewportRef.current;
    const viewport: ImportViewport = { x: worldOffset.x, y: worldOffset.y, zoom, width: element?.clientWidth ?? 640, height: element?.clientHeight ?? 480 };
    setBusy(true);
    try {
      const payload = await Promise.all(accepted.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })));
      const succeeded = await update(() => window.imageBoard.importImages(state.activeCanvasId, payload, viewport));
      if (succeeded) setNotice(`已导入 ${accepted.length} 张图片`);
      return succeeded;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入失败");
      return false;
    } finally { setBusy(false); }
  };

  const handleDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    showDropFeedback(await handleImport(event.dataTransfer.files) ? "success" : "error");
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
    const estimatedHeight = 190;
    let top = card.top - shell.top;
    if (!rightFits && !leftFits) top = card.bottom - shell.top + gap + estimatedHeight <= shell.height - 12 ? card.bottom - shell.top + gap : card.top - shell.top - estimatedHeight - gap;
    return { left: Math.round(Math.max(12, Math.min(left, shell.width - width - 12))), top: Math.round(Math.max(12, Math.min(top, shell.height - estimatedHeight - 12))) };
  };

  const selectImage = (event: React.MouseEvent<HTMLElement> | null, imageId: string) => {
    event?.stopPropagation();
    const anchor = event ? panelAnchorFor(event.currentTarget) : null;
    if (event?.shiftKey) {
      setSelectedIds((current) => {
        const next = current.includes(imageId) ? current.filter((id) => id !== imageId) : [...current, imageId];
        if (next.length === 0) setSelectionAnchor(null);
        else setSelectionAnchor(anchor);
        setPreviewId(null);
        return next;
      });
      return;
    }
    setSelectedIds([imageId]);
    setSelectionAnchor(anchor);
    setPreviewId(null);
  };

  const openPreview = (imageId: string) => {
    setPreviewId(imageId);
    setSelectedIds([]);
    setSelectionAnchor(null);
  };

  const persistViewport = async (nextOffset: { x: number; y: number }, nextZoom: number) => {
    if (!state?.activeCanvasId) return;
    setWorldOffset(nextOffset); setZoom(nextZoom);
    try { applyState(await window.imageBoard.setCanvasViewport(state.activeCanvasId, { x: nextOffset.x, y: nextOffset.y, zoom: nextZoom })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "视角保存失败"); }
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
    if (!rect || canvasImages.length === 0) { setNotice("当前画布还没有图片"); return; }
    const minX = Math.min(...canvasImages.map((image) => image.x));
    const minY = Math.min(...canvasImages.map((image) => image.y));
    const maxX = Math.max(...canvasImages.map((image) => image.x + image.width));
    const maxY = Math.max(...canvasImages.map((image) => image.y + image.height));
    const nextZoom = Math.min(1.5, Math.max(0.5, Math.min((rect.width - 72) / Math.max(1, maxX - minX), (rect.height - 72) / Math.max(1, maxY - minY))));
    const contentCenterX = (minX + maxX) / 2; const contentCenterY = (minY + maxY) / 2;
    void persistViewport({ x: rect.width / 2 - contentCenterX * nextZoom, y: rect.height / 2 - contentCenterY * nextZoom }, Number(nextZoom.toFixed(2)));
  };

  const startPan = (event: React.PointerEvent) => {
    const target = event.target as HTMLElement;
    if ((event.button !== 0 && event.button !== 1) || target.closest(".image-card, .quick-actions, .mini-map") || target.closest("button")) return;
    event.preventDefault();
    panRef.current = { x: event.clientX, y: event.clientY, ox: worldOffset.x, oy: worldOffset.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const movePan = (event: React.PointerEvent) => { if (panRef.current) setWorldOffset({ x: panRef.current.ox + event.clientX - panRef.current.x, y: panRef.current.oy + event.clientY - panRef.current.y }); };
  const stopPan = (event?: React.PointerEvent) => {
    if (!panRef.current) return;
    if (event && viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
    const next = worldOffset; panRef.current = null;
    if (state?.activeCanvasId) void persistViewport(next, zoom);
  };

  const openPrompt = (title: string, value = "") => new Promise<string | null>((resolve) => setDialog({ kind: "prompt", title, value, resolve }));
  const openConfirm = (title: string, message: string) => new Promise<boolean>((resolve) => setDialog({ kind: "confirm", title, message, resolve }));
  const changeCanvas = async (canvasId: string) => { if (canvasId === state?.activeCanvasId || busy) return; clearInteraction(); setBusy(true); try { applyState(await window.imageBoard.setActiveCanvas(canvasId)); } catch (caught) { setError(caught instanceof Error ? caught.message : "切换画布失败"); } finally { setBusy(false); } };
  const rename = async () => { if (!activeCanvas) return; const name = await openPrompt("重命名画布", activeCanvas.name); if (name !== null) void update(() => window.imageBoard.renameCanvas(activeCanvas.id, name)); };
  const removeCanvas = async () => { if (!activeCanvas) return; const confirmed = await openConfirm(`删除“${activeCanvas.name}”？`, "未分类图片会删除，已分类图片及其库文件会保留。此操作不可在应用内撤销。"); if (confirmed) { clearInteraction(); void update(() => window.imageBoard.deleteCanvas(activeCanvas.id)); } };
  const switchView = (next: ViewMode) => { setViewMode(next); clearInteraction(); setShowControls(false); };

  if (!state) return <div className="loading-card">{loadError ? <><strong>本地图片画布打开失败</strong><span>{loadError}</span><div className="loading-actions"><button className="primary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>重试</button><button onClick={() => void window.imageBoard.closeWindow()}>退出</button></div></> : "正在打开本地图片画布…"}</div>;
  if (!expanded) return <CollapsedBall settings={ballSettings} count={canvasImages.length} dropActive={dropActive} dropFeedback={dropFeedback} onOpen={() => toggleExpanded(true)} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} />;

  return <main ref={appShellRef} className={`app-shell ${dropActive ? "drop-active" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    <header className="topbar"><div className="window-drag-region"><div className="brand-mark"><BloubBall settings={ballSettings} /></div><div className="brand-copy"><strong>快捷图片画布</strong><span>{viewMode === "settings" ? "小球与本地路径" : "本地临时整理区"}</span></div></div><div className="topbar-actions"><button className={viewMode === "canvas" ? "active" : ""} onClick={() => switchView("canvas")}>画布</button><button className={viewMode === "library" ? "active" : ""} onClick={() => switchView("library")}>分类库</button><button className={`icon-button no-drag settings-button ${viewMode === "settings" ? "active" : ""}`} title="打开设置" onClick={() => switchView("settings")}>⚙</button>{viewMode === "canvas" && <button className={`icon-button no-drag tool-toggle ${showControls ? "active" : ""}`} title={showControls ? "收起画布工具" : "展开画布工具"} onClick={() => setShowControls((visible) => !visible)}>•••</button>}<button className="icon-button no-drag" title="收起" onClick={() => toggleExpanded(false)}>—</button><button className="icon-button no-drag close-window" title="退出" onClick={() => void window.imageBoard.closeWindow()}>×</button></div></header>
    {viewMode === "canvas" ? <>
      {showControls && <div className="canvas-controls"><div className="canvas-tabs">{state.canvases.map((canvas) => <button key={canvas.id} className={canvas.id === state.activeCanvasId ? "canvas-tab active" : "canvas-tab"} onClick={() => void changeCanvas(canvas.id)}>{canvas.name}<small>{canvas.imageIds.length}</small></button>)}<button className="add-canvas" onClick={() => { clearInteraction(); void update(() => window.imageBoard.createCanvas()); }}>＋ 新画布</button></div><div className="canvas-toolbar"><span>{activeCanvas?.name ?? "当前画布"}</span><span className="toolbar-hint">空白处平移 · 拖动图片定位 · Shift+单击多选 · Ctrl+C 复制文件 · Ctrl+V 粘贴</span><div className="zoom-controls"><button title="缩小" onClick={() => zoomBy(-0.1)}>−</button><span>{Math.round(zoom * 100)}%</span><button title="放大" onClick={() => zoomBy(0.1)}>＋</button><button className="locate-button" onClick={locateAll}>定位全部</button></div></div></div>}
      <div ref={viewportRef} className={`canvas-viewport ${dropActive ? "drop-active" : ""}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan} onLostPointerCapture={stopPan}><div className="canvas-world" style={{ transform: `translate(${worldOffset.x}px, ${worldOffset.y}px) scale(${zoom})` }}>{canvasImages.length === 0 && <div className="empty-canvas"><div className="empty-icon">↘</div><strong>把图片拖到悬浮窗</strong><span>或点击后使用 Ctrl+V 粘贴到当前画布</span></div>}{canvasImages.map((image) => <CanvasImage key={image.id} image={image} zoom={zoom} selected={selectedIds.includes(image.id)} onSelect={selectImage} onPreview={openPreview} onHover={setHoveredId} onMove={(id, x, y) => void update(() => window.imageBoard.moveImage(id, x, y))} />)}</div><MiniMap images={canvasImages} viewportRef={viewportRef} worldOffset={worldOffset} zoom={zoom} onNavigate={(next) => void persistViewport(next, zoom)} /></div>
      {showControls && activeCanvas && <div className="footer-actions"><button onClick={() => void rename()}>重命名画布</button><button className="danger-link" onClick={() => void removeCanvas()}>删除画布</button></div>}
    </> : viewMode === "library" ? <Library state={state} onPreview={openPreview} onSelect={selectImage} onCopy={(ids) => void copyFiles(ids)} /> : <SettingsPage state={state} ballSettings={ballSettings} pathSettings={pathSettings} onBallSettingsChange={(patch) => setBallSettings((current) => ({ ...current, ...patch }))} onPathSettingsChange={(patch) => setPathSettings((current) => ({ ...current, ...patch }))} onResetBall={() => setBallSettings({ ...DEFAULT_BALL_SETTINGS })} onAddCategory={async () => { const name = await openPrompt("新建分类"); if (!name) return false; return update(() => window.imageBoard.createCategory(name)); }} />}
    {selectedIds.length > 0 && viewMode === "canvas" && <QuickActions state={state} selectedIds={selectedIds} anchor={selectionAnchor} showRemove={true} onClose={clearInteraction} onUpdate={applyState} onError={setError} onNotice={setNotice} onPrompt={openPrompt} />}
    {selectedIds.length > 0 && viewMode === "library" && <QuickActions state={state} selectedIds={selectedIds} anchor={selectionAnchor} showRemove={false} onClose={clearInteraction} onUpdate={applyState} onError={setError} onNotice={setNotice} onPrompt={openPrompt} />}
    {previewImage && <QuickPreview image={previewImage} onClose={() => { setPreviewId(null); setHoveredId(null); }} onClassify={() => { setSelectedIds([previewImage.id]); setSelectionAnchor(null); setPreviewId(null); }} onCopy={() => void copyFiles([previewImage.id])} />}
    {busy && <div className="busy-toast">{copying ? "正在复制图片文件…" : "正在处理…"}</div>}{notice && <div className="notice-toast" onClick={() => setNotice("")}>{notice}</div>}{error && <div className="error-toast">{error}</div>}
    {dialog && <Dialog dialog={dialog} onClose={() => setDialog(null)} />}
  </main>;
}

function CollapsedBall({ settings, count, dropActive, dropFeedback, onOpen, onDragEnter, onDragOver, onDragLeave, onDrop }: { settings: BallSettings; count: number; dropActive: boolean; dropFeedback: DropFeedback; onOpen: () => void; onDragEnter: (event: React.DragEvent) => void; onDragOver: (event: React.DragEvent) => void; onDragLeave: (event: React.DragEvent) => void; onDrop: (event: React.DragEvent) => void }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activePointerRef = useRef<number | "mouse" | null>(null);
  const holdPointRef = useRef({ x: 0, y: 0 });
  const dragStartedRef = useRef(false);
  const onOpenRef = useRef(onOpen);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  const clearTimer = useCallback(() => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = null; }, []);
  const finish = useCallback((shouldOpen: boolean) => {
    clearTimer();
    const wasDragging = dragStartedRef.current;
    const pointerId = activePointerRef.current;
    const hadCapture = typeof pointerId === "number" && shellRef.current?.hasPointerCapture(pointerId);
    activePointerRef.current = null;
    dragStartedRef.current = false;
    setDragging(false);
    if (wasDragging) void window.imageBoard.endWindowDrag();
    if (hadCapture && typeof pointerId === "number") shellRef.current?.releasePointerCapture(pointerId);
    if (shouldOpen && !wasDragging) onOpenRef.current();
  }, [clearTimer]);
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
      void window.imageBoard.startWindowDrag();
    }, 250);
  }, [clearTimer]);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => { if (event.button === 0) beginHold(event.pointerId, event); };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current && Math.hypot(event.clientX - holdPointRef.current.x, event.clientY - holdPointRef.current.y) >= 6) { clearTimer(); dragStartedRef.current = true; setDragging(true); void window.imageBoard.startWindowDrag(); } };
  const mouseDown = (event: React.MouseEvent<HTMLDivElement>) => { if (event.button === 0 && activePointerRef.current === null) beginHold("mouse", event); };
  const mouseMove = (event: React.MouseEvent<HTMLDivElement>) => { if (activePointerRef.current === "mouse" && !dragStartedRef.current && Math.hypot(event.clientX - holdPointRef.current.x, event.clientY - holdPointRef.current.y) >= 6) { clearTimer(); dragStartedRef.current = true; setDragging(true); void window.imageBoard.startWindowDrag(); } };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId) finish(true); };
  const mouseUp = () => { if (activePointerRef.current === "mouse") finish(true); };
  const pointerCancel = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current) finish(false); };
  const lostPointerCapture = (event: React.PointerEvent<HTMLDivElement>) => { if (activePointerRef.current === event.pointerId && !dragStartedRef.current) finish(false); };

  return <div ref={shellRef} className={`collapsed-shell ${dragging ? "dragging" : ""} ${dropActive ? "drop-active" : ""}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={lostPointerCapture} onMouseDown={mouseDown} onMouseMove={mouseMove} onMouseUp={mouseUp} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} title="短点展开，长按拖动">
    <div className="collapsed-ball"><BloubBall settings={settings} dragOpen={dropActive} dropState={dropFeedback} />{count > 0 && <span className="collapsed-count">{count}</span>}{dropFeedback && <span className={`drop-feedback ${dropFeedback}`}>{dropFeedback === "success" ? "✓" : "!"}</span>}</div>
  </div>;
}

function MiniMap({ images, viewportRef, worldOffset, zoom, onNavigate }: { images: ImageRecord[]; viewportRef: React.RefObject<HTMLDivElement>; worldOffset: { x: number; y: number }; zoom: number; onNavigate: (next: { x: number; y: number }) => void }) {
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
    onNavigate({ x: viewWidth / 2 - point.x * zoom, y: viewHeight / 2 - point.y * zoom });
  };
  const pointerDown = (event: React.PointerEvent) => { event.stopPropagation(); setDragging(true); mapRef.current?.setPointerCapture(event.pointerId); navigate(event); };
  const pointerMove = (event: React.PointerEvent) => { if (dragging) navigate(event); };
  const pointerUp = (event: React.PointerEvent) => { setDragging(false); if (mapRef.current?.hasPointerCapture(event.pointerId)) mapRef.current.releasePointerCapture(event.pointerId); };
  return <div ref={mapRef} className={`mini-map ${dragging ? "dragging" : ""}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => setDragging(false)} onClick={(event) => event.stopPropagation()} aria-label="画布小地图"><svg viewBox={`0 0 ${width} ${height}`} role="img"><rect className="mini-map-bg" x="0" y="0" width={width} height={height} rx="10" />{geometry.images.map((image) => <rect key={image.id} className="mini-map-image" x={image.x} y={image.y} width={image.width} height={image.height} rx="2" />)}<rect className="mini-map-viewport" x={geometry.viewport.x} y={geometry.viewport.y} width={geometry.viewport.width} height={geometry.viewport.height} rx="3" /></svg></div>;
}

function SettingsPage({ state, ballSettings, pathSettings, onBallSettingsChange, onPathSettingsChange, onResetBall, onAddCategory }: { state: AppState; ballSettings: BallSettings; pathSettings: PathSettings; onBallSettingsChange: (patch: Partial<BallSettings>) => void; onPathSettingsChange: (patch: Partial<PathSettings>) => void; onResetBall: () => void; onAddCategory: () => Promise<boolean> }) {
  return <section className="settings-view"><div className="settings-heading"><div><span className="settings-kicker">PERSONALIZE</span><h1>设置</h1><p>让小球更像你的快捷入口，路径和分类也集中在这里管理。</p></div><div className="settings-ball-preview"><BloubBall settings={ballSettings} /></div></div>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>小球外观</strong><span>颜色、形状与脸部动效会在收纳态立即生效。</span></div><button className="text-button" onClick={onResetBall}>恢复默认</button></div><div className="settings-row"><div className="settings-field settings-field-wide"><label>主体颜色</label><div className="color-options">{COLORS.map((color) => <button key={color.id} className={`color-swatch ${ballSettings.colorId === color.id ? "selected" : ""}`} style={{ backgroundColor: color.hex }} title={color.id} aria-label={`选择${color.id}色`} onClick={() => onBallSettingsChange({ colorId: color.id })} />)}</div></div><label className="settings-field color-picker-field">眼睛颜色<input type="color" value={ballSettings.eyeColor} onChange={(event) => onBallSettingsChange({ eyeColor: event.target.value })} /></label></div><div className="settings-row"><label className="settings-field"><span>身体形状</span><select value={ballSettings.shapeId} onChange={(event) => onBallSettingsChange({ shapeId: event.target.value })}>{SHAPES.map((shape) => <option key={shape.id} value={shape.id}>{shape.id}</option>)}</select></label><label className="settings-field"><span>表情模式</span><select value={ballSettings.animation} onChange={(event) => onBallSettingsChange({ animation: event.target.value as BallSettings["animation"] })}><option value="random">随机表情</option><option value="rest">安静呼吸</option><option value="spark">更多动效</option></select></label></div><div className="settings-row"><label className="range-field"><span><b>播放速度</b><output>{ballSettings.speed.toFixed(1)}×</output></span><input type="range" min="0.5" max="2" step="0.1" value={ballSettings.speed} onChange={(event) => onBallSettingsChange({ speed: Number(event.target.value) })} /></label><label className="range-field"><span><b>动效强度</b><output>{Math.round(ballSettings.motion * 100)}%</output></span><input type="range" min="0" max="1" step="0.05" value={ballSettings.motion} onChange={(event) => onBallSettingsChange({ motion: Number(event.target.value) })} /></label></div><label className="settings-toggle"><input type="checkbox" checked={ballSettings.followGaze} onChange={(event) => onBallSettingsChange({ followGaze: event.target.checked })} /><span><b>跟随指针</b><small>指针靠近小球时，眼睛会跟着看。</small></span></label></section>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>本地路径</strong><span>只保存路径偏好，不会自动搬运或删除已有图片。</span></div></div><div className="path-fields"><label className="settings-field"><span>文件路径</span><input value={pathSettings.filePath} onChange={(event) => onPathSettingsChange({ filePath: event.target.value })} placeholder="quick-image-board" /></label><label className="settings-field"><span>分类图片路径</span><input value={pathSettings.classifiedPath} onChange={(event) => onPathSettingsChange({ classifiedPath: event.target.value })} placeholder="quick-image-board/classified" /></label><label className="settings-field"><span>画布临时路径</span><input value={pathSettings.temporaryPath} onChange={(event) => onPathSettingsChange({ temporaryPath: event.target.value })} placeholder="quick-image-board/pending" /></label></div><p className="settings-note">路径变更不会在当前版本执行迁移；现有数据仍由应用的本地存储目录保护。</p></section>
    <section className="settings-section"><div className="settings-section-heading"><div><strong>分类类别</strong><span>分类会直接写入当前本地图片库。</span></div><button className="primary-button small-button" onClick={() => void onAddCategory()}>＋ 新建分类</button></div><div className="category-list">{state.categories.map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}</div></section>
  </section>;
}

function CanvasImage({ image, zoom, selected, onSelect, onPreview, onHover, onMove }: { image: ImageRecord; zoom: number; selected: boolean; onSelect: (event: React.MouseEvent<HTMLElement> | null, id: string) => void; onPreview: (id: string) => void; onHover: (id: string | null) => void; onMove: (id: string, x: number, y: number) => void }) {
  const nodeRef = useRef<HTMLElement>(null);
  const rafRef = useRef<number | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, left: image.x, top: image.y });
  const [dragging, setDragging] = useState(false);

  const cancelFrame = () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  const restoreTransform = () => { cancelFrame(); if (nodeRef.current) nodeRef.current.style.transform = ""; };
  useEffect(() => () => cancelFrame(), []);
  const pointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    movedRef.current = false;
    suppressClickRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY, left: image.x, top: image.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    const deltaX = (event.clientX - startRef.current.x) / zoom;
    const deltaY = (event.clientY - startRef.current.y) / zoom;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) movedRef.current = true;
    const node = event.currentTarget;
    cancelAnimationFrame(rafRef.current ?? 0);
    rafRef.current = requestAnimationFrame(() => {
      node.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0) scale(1.035) rotate(1deg)`;
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
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerUp = (event: React.PointerEvent<HTMLElement>) => finish(event, true);
  const pointerCancel = (event: React.PointerEvent<HTMLElement>) => finish(event, false);
  const lostPointerCapture = (event: React.PointerEvent<HTMLElement>) => finish(event, false);
  const click = (event: React.MouseEvent<HTMLElement>) => { if (suppressClickRef.current) { suppressClickRef.current = false; event.preventDefault(); return; } onSelect(event, image.id); };
  const doubleClick = (event: React.MouseEvent<HTMLElement>) => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } event.stopPropagation(); onPreview(image.id); };

  return <article ref={nodeRef} className={`image-card ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`} style={{ left: image.x, top: image.y }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onLostPointerCapture={lostPointerCapture} onMouseEnter={() => onHover(image.id)} onMouseLeave={() => onHover(null)} onClick={click} onDoubleClick={doubleClick}>{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} draggable={false} /> : <div className="image-missing">预览不可用</div>}<div className="image-meta"><span className={image.status === "classified" ? "status-dot classified" : "status-dot"}></span><span title={image.fileName}>{image.fileName}</span></div></article>;
}

function QuickPreview({ image, onClose, onClassify, onCopy }: { image: ImageRecord; onClose: () => void; onClassify: () => void; onCopy: () => void }) {
  return <div className="preview-backdrop" onMouseDown={onClose}><section className="preview-card" role="dialog" aria-label="图片预览" onMouseDown={(event) => event.stopPropagation()}><div className="preview-header"><span>快速预览</span><button className="close-button" onClick={onClose} title="关闭预览">×</button></div><div className="preview-image-wrap">{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} /> : <div className="image-missing">预览不可用</div>}</div><div className="preview-meta"><strong title={image.fileName}>{image.fileName}</strong><span>{image.status === "classified" ? "已归档图片" : "临时图片"}</span></div><div className="preview-actions"><button onClick={onClassify}>分类</button><button onClick={onCopy}>复制</button></div></section></div>;
}

function QuickActions({ state, selectedIds, anchor, showRemove, onClose, onUpdate, onError, onNotice, onPrompt }: { state: AppState; selectedIds: string[]; anchor: PanelAnchor | null; showRemove: boolean; onClose: () => void; onUpdate: (state: AppState) => void; onError: (message: string) => void; onNotice: (message: string) => void; onPrompt: (title: string, value?: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const selected = selectedIds.map((id) => state.images[id]).filter(Boolean);
  const classify = async (categoryId: string) => { setBusy(true); try { onUpdate(await window.imageBoard.classifyImages(selectedIds, categoryId)); onNotice("分类已保存"); onClose(); } catch (error) { onError(error instanceof Error ? error.message : "分类失败"); } finally { setBusy(false); } };
  const createCategory = async () => { const name = await onPrompt("新建分类"); if (!name) return; setBusy(true); try { onUpdate(await window.imageBoard.createCategory(name)); onNotice("分类已创建"); } catch (error) { onError(error instanceof Error ? error.message : "创建分类失败"); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); try { let next = state; for (const id of selectedIds) next = await window.imageBoard.removeImageFromCanvas(id); onUpdate(next); onClose(); } catch (error) { onError(error instanceof Error ? error.message : "移除失败"); } finally { setBusy(false); } };
  const copy = async () => { try { const result = await window.imageBoard.copyImageFiles(selectedIds); onNotice(result.copied > 1 ? `已复制 ${result.copied} 个图片文件` : result.copied > 0 ? "已复制图片文件" : "没有复制图片文件"); } catch (error) { onError(error instanceof Error ? error.message : "复制失败"); } };
  return <aside className={`quick-actions ${anchor ? "anchored" : ""}`} style={anchor ? { left: anchor.left, top: anchor.top } : undefined}><div className="quick-actions-title"><div><strong>{selectedIds.length > 1 ? `已选 ${selectedIds.length} 张图片` : "图片快捷操作"}</strong><span>{selected[0]?.status === "classified" ? "已归档图片" : "临时图片"}</span></div><button className="close-button" onClick={onClose}>×</button></div><div className="category-label">选择分类{selectedIds.length > 1 ? "（批量）" : ""}</div><div className="category-grid">{state.categories.map((category) => <button key={category.id} disabled={busy} onClick={() => void classify(category.id)}>{category.name}</button>)}<button className="new-category" disabled={busy} onClick={() => void createCategory()}>＋ 新分类</button></div><div className="quick-actions-footer"><button onClick={() => void copy()}>复制图片文件</button>{showRemove && <button className="danger-link" disabled={busy} onClick={() => void remove()}>从画布移除</button>}</div></aside>;
}

function Library({ state, onPreview, onSelect, onCopy }: { state: AppState; onPreview: (id: string) => void; onSelect: (event: React.MouseEvent<HTMLElement> | null, id: string) => void; onCopy: (ids: string[]) => void }) {
  const categorized = useMemo(() => Object.values(state.images).filter((image) => image.status === "classified"), [state.images]);
  return <section className="library-view"><div className="library-heading"><div><strong>分类图片库</strong><span>已分类图片不会因画布删除而消失</span></div><span>{categorized.length} 张</span></div>{state.categories.map((category) => { const images = categorized.filter((image) => image.categoryId === category.id); return <div className="library-group" key={category.id}><div className="library-group-title"><strong>{category.name}</strong><span>{images.length}</span></div><div className="library-grid">{images.map((image) => <article className="library-card" key={image.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onSelect(event, image.id); }} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button")) { event.stopPropagation(); onPreview(image.id); } }}>{image.dataUrl ? <img src={image.dataUrl} alt={image.fileName} /> : <div className="image-missing">预览不可用</div>}<span title={image.fileName}>{image.fileName}</span><div className="library-card-actions"><button onClick={(event) => { event.stopPropagation(); onSelect(event, image.id); }}>重新分类</button><button onClick={() => onCopy([image.id])}>复制</button></div></article>)}</div></div>})}{categorized.length === 0 && <div className="library-empty">还没有已分类图片。回到画布，点击图片即可归档。</div>}</section>;
}

function Dialog({ dialog, onClose }: { dialog: DialogState; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(dialog.kind === "prompt" ? dialog.value : "");
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const finish = (result: string | null | boolean) => { dialog.resolve(result as never); onClose(); };
  return <div className="dialog-backdrop" onMouseDown={() => finish(dialog.kind === "prompt" ? null : false)}><section className="dialog-card" onMouseDown={(event) => event.stopPropagation()}><strong>{dialog.title}</strong>{dialog.kind === "prompt" ? <input ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") finish(value); if (event.key === "Escape") finish(null); }} /> : <p>{dialog.message}</p>}<div className="dialog-actions"><button onClick={() => finish(dialog.kind === "prompt" ? null : false)}>取消</button><button className={dialog.kind === "confirm" ? "danger-button" : "primary-button"} onClick={() => finish(dialog.kind === "prompt" ? value : true)}>{dialog.kind === "confirm" ? "删除" : "确定"}</button></div></section></div>;
}

export default App;
