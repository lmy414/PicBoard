import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppState } from "../../../shared/image-board";
import { KIND_LABEL, buildPlacementIndex, contentTitle, formatByteSize, formatTimestamp, relativeTime } from "../content/content-meta";
import { IconArrowLeft, IconCanvas, IconCopy, IconTag, KindIcon } from "../ui/ContentIcons";
import { IconDots, IconInfo } from "../ui/Icons";
import { Popover } from "../ui/Popover";
import { ImageContentPage } from "./ImageContentPage";
import { ImageEditor } from "./ImageEditor";
import { LinkContentPage } from "./LinkContentPage";
import type { ContentLifecycle, ContentPageApi, SaveStatus } from "./page-types";
import "./content-page.css";
import "./editor.css";

// TipTap is the heaviest renderer dependency; load it only when a text page opens.
const TextContentPage = lazy(() =>
  import("./TextContentPage").then((module) => ({ default: module.TextContentPage })),
);

function EditorFallback() {
  return (
    <div className="cp-text-page">
      <div className="cp-editor-scroll">
        <div className="cp-editor-column">
          <div className="cp-editor-skeleton motion-fade" data-motion="enter" aria-busy="true" aria-label="编辑器载入中">
            <span className="cp-skeleton-line cp-skeleton-title" />
            <span className="cp-skeleton-line" />
            <span className="cp-skeleton-line cp-skeleton-short" />
            <span className="cp-skeleton-line" />
            <span className="cp-skeleton-line cp-skeleton-short" />
          </div>
        </div>
      </div>
    </div>
  );
}

export interface ContentPageProps {
  state: AppState;
  contentId: string;
  /** Shared compact toolbar above the workspace; null temporarily hides it. */
  toolbarHost?: HTMLElement | null;
  navigationGuardRef?: React.MutableRefObject<(() => boolean | Promise<boolean>) | null>;
  onOpenContent?(contentId: string): void;
  onState(state: AppState): void;
  onClose(): void;
  onCopy(contentIds: string[]): void;
  onQuickActions(origin: HTMLElement, contentId: string): void;
  onOpenCanvas(canvasId: string, contentId: string): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "已保存",
  saving: "保存中…",
  error: "保存失败",
};

/** Crossfades the previous save state out while the next one eases in. */
function SaveStatusChip({ status }: { status: SaveStatus }) {
  const [current, setCurrent] = useState(status);
  const [previous, setPrevious] = useState<SaveStatus | null>(null);
  const currentRef = useRef(current);
  const timerRef = useRef<number | null>(null);
  currentRef.current = current;

  useEffect(() => {
    if (status === currentRef.current) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setPrevious(currentRef.current);
    setCurrent(status);
    timerRef.current = window.setTimeout(() => {
      setPrevious(null);
      timerRef.current = null;
    }, 140);
  }, [status]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <span
      className="cp-save-wrap"
      aria-live="polite"
      title={status === "error" ? "保存失败，继续编辑后会重试" : undefined}
    >
      {previous ? (
        <span
          key={`${previous}-${current}`}
          className={`cp-save-status cp-save-${previous} is-ghost motion-fade`}
          data-motion="exit"
          aria-hidden="true"
        >
          {SAVE_LABEL[previous]}
        </span>
      ) : null}
      <span key={current} className={`cp-save-status cp-save-${current} motion-fade`} data-motion="enter">
        {SAVE_LABEL[current]}
      </span>
    </span>
  );
}

/**
 * Full-page view/editor for one content. Owns the shared header, Esc and the
 * close/flush lifecycle; the kind pages own their body and popups.
 */
export function ContentPage(props: ContentPageProps) {
  const { state, contentId } = props;
  const content = state.contents[contentId];
  const apiRef = useRef<ContentPageApi>({});
  const lifecycleRef = useRef<ContentLifecycle>({ discard: false });
  const closingRef = useRef(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [now, setNow] = useState(() => Date.now());
  const [infoOpen, setInfoOpen] = useState(false);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const [imageToolbarHost, setImageToolbarHost] = useState<HTMLDivElement | null>(null);
  const [editingImage, setEditingImage] = useState(false);

  useEffect(() => {
    const guard = () => apiRef.current.beforeClose?.() ?? true;
    if (props.navigationGuardRef) props.navigationGuardRef.current = guard;
    return () => { if (props.navigationGuardRef?.current === guard) props.navigationGuardRef.current = null; };
  }, [props.navigationGuardRef]);

  // A removed content must never be saved again. This is read by the kind
  // page's unmount cleanup, which runs before effects of this render.
  if (!content) lifecycleRef.current.discard = true;

  const category = useMemo(
    () => (content?.categoryId ? state.categories.find((entry) => entry.id === content.categoryId) ?? null : null),
    [content?.categoryId, state.categories],
  );
  const placementIndex = useMemo(() => buildPlacementIndex(state), [state.canvases]);
  const canvasNames = useMemo(() => {
    if (!content) return [] as Array<{ id: string; name: string }>;
    const ids = placementIndex.get(content.id) ?? [];
    const byId = new Map(state.canvases.map((canvas) => [canvas.id, canvas.name] as const));
    return ids.map((id) => ({ id, name: byId.get(id) ?? id }));
  }, [content?.id, placementIndex, state.canvases]);

  const closePage = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (await apiRef.current.beforeClose?.() === false) { closingRef.current = false; return; }
    try {
      await apiRef.current.flush?.();
    } catch {
      // The kind page reports save failures; closing must still work.
    }
    props.onClose();
  }, [props.onClose]);

  const closeRef = useRef(closePage);
  closeRef.current = closePage;

  // Esc belongs to the page while it is mounted: dialogs and the actions
  // menu keep it first, then our own popups, then the page itself. Capture
  // phase is deliberate: ProseMirror handles Escape at the contenteditable,
  // and a stale editor popup must not be able to mark the key as handled
  // before the page sees it.
  useEffect(() => {
    if (!content) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (document.querySelector('[data-esc-layer], .dialog-card, .content-actions, .canvas-context-menu')) return;
      if (apiRef.current.closePopups?.()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [Boolean(content), contentId]);

  useEffect(() => {
    if (content || closingRef.current) return;
    // Deletion elsewhere wins over an in-flight editor: close without flushing.
    closingRef.current = true;
    props.onClose();
    // onClose is stable in the app shell; only a vanished content triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(content)]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!content) return null;

  const editable = content.kind === "text" || content.kind === "richText";

  const callbacks = {
    onState: props.onState,
    onError: props.onError,
    onNotice: props.onNotice,
    onSaveStatus: setSaveStatus,
  };

  const toolbar = (
      <div className="cp-toolbar" role="toolbar" aria-label="内容工具">
        {props.toolbarHost === undefined && (
          <button
            className="cp-back"
            title="返回 (Esc)"
            onClick={() => void closePage()}
          >
            <IconArrowLeft size={15} />
            <span>返回</span>
          </button>
        )}
          <span className="cp-kind-chip">
            <KindIcon kind={content.kind} size={13} />
            {KIND_LABEL[content.kind]}
          </span>
          {category ? (
            <span className="cp-category-chip" title={`分类：${category.name}`}>
              <IconTag size={12} />
              {category.name}
            </span>
          ) : null}
          <button type="button" ref={infoButtonRef} className={`cp-action cp-info-trigger${infoOpen ? " active" : ""}`} title="内容信息" aria-label="内容信息" aria-expanded={infoOpen} aria-haspopup="dialog" onClick={() => setInfoOpen((open) => !open)}><IconInfo size={14} /><span>信息</span></button>
          <span className="cp-toolbar-grow" />
          {content.kind === "image" && <div ref={setImageToolbarHost} className="cp-image-tools-host" />}
          {content.kind === "image" && <button type="button" className="cp-action" onClick={() => { setInfoOpen(false); setEditingImage(true); }}>编辑图像</button>}
          {editable ? <SaveStatusChip status={saveStatus} /> : null}
          <button className="cp-action" onClick={() => props.onCopy([content.id])} title="复制到剪贴板" aria-label="复制">
            <IconCopy size={14} />
            <span>复制</span>
          </button>
          <button
            className="cp-action cp-action-icon"
            aria-label="内容操作"
            aria-haspopup="menu"
            title="内容操作"
            onClick={(event) => props.onQuickActions(event.currentTarget, content.id)}
          >
            <IconDots size={16} />
          </button>
      </div>
  );

  return (
    <div className={`cp-page cp-page-${content.kind}`}>
      {!editingImage && (props.toolbarHost ? createPortal(toolbar, props.toolbarHost) : props.toolbarHost === undefined ? toolbar : null)}
      <Popover open={infoOpen} anchor={infoButtonRef.current} onClose={() => setInfoOpen(false)} width={320} className="cp-info-panel" panelProps={{ role: "dialog", "aria-label": "内容信息" }}>
        <strong className="cp-info-title">{contentTitle(content)}</strong>
        {content.image && <div className="cp-info-image"><span>{content.image.width} × {content.image.height}</span><span>{formatByteSize(content.image.byteSize)}</span></div>}
        <div className="cp-info-times">
          <span className="cp-time" title={formatTimestamp(content.createdAt)}>
            创建于 {relativeTime(content.createdAt, now)}
          </span>
          <span className="cp-time" title={formatTimestamp(content.updatedAt)}>
            编辑于 {relativeTime(content.updatedAt, now)}
          </span>
        </div>
          {canvasNames.length > 0 ? (
            <span className="cp-placements">
              <IconCanvas size={12} />
              <span>出现在 {canvasNames.length} 个画布</span>
              <span className="cp-canvas-list">
                {canvasNames.map((canvas) => (
                  <button
                    key={canvas.id}
                    className="cp-canvas-chip"
                    title={`在画布「${canvas.name}」中查看`}
                    onClick={() => { setInfoOpen(false); props.onOpenCanvas(canvas.id, content.id); }}
                  >
                    {canvas.name}
                  </button>
                ))}
              </span>
            </span>
          ) : (
            <span className="cp-placements cp-placements-empty">
              <IconCanvas size={12} />
              仅在剪贴板历史中
            </span>
          )}
      </Popover>

      <div className="cp-body">
        {content.kind === "image" && editingImage ? (
          <ImageEditor content={content} toolbarHost={props.toolbarHost} apiRef={apiRef} onCancel={() => setEditingImage(false)} onSaved={(result) => { props.onState(result.state); setEditingImage(false); props.onNotice("已保存图片副本，原图保留"); props.onOpenContent?.(result.contentId); }} onError={props.onError} onNotice={props.onNotice} />
        ) : content.kind === "image" ? (
          <ImageContentPage key={content.id} content={content} onError={props.onError} toolbarHost={imageToolbarHost} />
        ) : content.kind === "link" ? (
          <LinkContentPage
            key={content.id}
            content={content}
            apiRef={apiRef}
            onState={props.onState}
            onError={props.onError}
            onNotice={props.onNotice}
            onCopy={props.onCopy}
          />
        ) : (
          <Suspense fallback={<EditorFallback />}>
            <TextContentPage
              key={content.id}
              content={content}
              lifecycle={lifecycleRef.current}
              apiRef={apiRef}
              callbacks={callbacks}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
