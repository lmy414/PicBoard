import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContentRecord } from "../../../shared/image-board";
import { formatByteSize } from "../content/content-meta";
import { easeOutCubic } from "../ui/motion";
import { IconFit } from "../ui/ContentIcons";
import { IconMinus, IconPlus } from "../ui/Icons";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const FIT_PADDING = 28;
const ZOOM_STEP = 1.25;

interface View {
  /** Scale relative to the intrinsic pixel size (1 = 100%). */
  scale: number;
  /** Offset of the image center from the viewport center, in CSS px. */
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

/**
 * Image viewer: fit on open, wheel zoom around the pointer, pointer pan,
 * double-click fit ↔ 100%. Gestures write the transform and the zoom label
 * straight to the DOM; no React state updates per frame.
 */
export function ImageContentPage({ content, onError, toolbarHost, compact = false }: { content: ContentRecord; onError(message: string): void; toolbarHost?: HTMLElement | null; compact?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const targetRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const frameRef = useRef<number | null>(null);
  const animationRef = useRef<{ from: View; to: View; started: number; duration: number } | null>(null);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const naturalRef = useRef<Size>({
    width: content.image?.width ?? 0,
    height: content.image?.height ?? 0,
  });
  const fitRef = useRef(1);
  const fitModeRef = useRef(true);
  const initializedRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const percentLabelRef = useRef<HTMLSpanElement>(null);
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});

  const [natural, setNatural] = useState<Size>(naturalRef.current);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imageUrl = window.imageBoard.imageUrl(content.id, "full");
  const image = content.image;

  const applyView = useCallback((view: View) => {
    const stage = stageRef.current;
    if (stage) {
      stage.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    // Written straight to the DOM so gestures never trigger a React render.
    const label = percentLabelRef.current;
    if (label) {
      const next = `${Math.round(view.scale * 100)}%`;
      if (label.textContent !== next) label.textContent = next;
    }
  }, []);

  const minScale = useCallback(() => Math.min(MIN_SCALE, fitRef.current || MIN_SCALE), []);
  const maxScale = useCallback(() => Math.max(MAX_SCALE, fitRef.current || MAX_SCALE), []);

  const clampView = useCallback(
    (view: View): View => {
      const scale = Math.min(maxScale(), Math.max(minScale(), Number.isFinite(view.scale) ? view.scale : 1));
      const viewport = sizeRef.current;
      const size = naturalRef.current;
      const limitX = Math.max(0, (size.width * scale - viewport.width) / 2);
      const limitY = Math.max(0, (size.height * scale - viewport.height) / 2);
      return {
        scale,
        x: Math.min(limitX, Math.max(-limitX, Number.isFinite(view.x) ? view.x : 0)),
        y: Math.min(limitY, Math.max(-limitY, Number.isFinite(view.y) ? view.y : 0)),
      };
    },
    [maxScale, minScale],
  );

  const computeFit = useCallback((): number => {
    const viewport = sizeRef.current;
    const size = naturalRef.current;
    if (viewport.width <= 0 || viewport.height <= 0 || size.width <= 0 || size.height <= 0) return 1;
    const fit = Math.min(
      (viewport.width - FIT_PADDING * 2) / size.width,
      (viewport.height - FIT_PADDING * 2) / size.height,
    );
    return fit > 0 ? fit : MIN_SCALE;
  }, []);

  const setViewImmediate = useCallback(
    (view: View) => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      animationRef.current = null;
      const clamped = clampView(view);
      viewRef.current = clamped;
      targetRef.current = clamped;
      applyView(clamped);
    },
    [applyView, clampView],
  );

  const animateTo = useCallback(
    (view: View, duration = 220) => {
      const goal = clampView(view);
      targetRef.current = goal;
      const reducedMotion =
        typeof window !== "undefined" && typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
          : false;
      animationRef.current = { from: viewRef.current, to: goal, started: performance.now(), duration: reducedMotion ? 0 : duration };
      if (frameRef.current !== null) return;
      const step = (now: number) => {
        const animation = animationRef.current;
        if (!animation) {
          frameRef.current = null;
          return;
        }
        const progress = animation.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - animation.started) / animation.duration));
        const eased = easeOutCubic(progress);
        const next = {
          scale: animation.from.scale + (animation.to.scale - animation.from.scale) * eased,
          x: animation.from.x + (animation.to.x - animation.from.x) * eased,
          y: animation.from.y + (animation.to.y - animation.from.y) * eased,
        };
        viewRef.current = next;
        applyView(next);
        if (progress < 1) {
          frameRef.current = window.requestAnimationFrame(step);
        } else {
          viewRef.current = animation.to;
          applyView(animation.to);
          animationRef.current = null;
          frameRef.current = null;
        }
      };
      frameRef.current = window.requestAnimationFrame(step);
    },
    [applyView, clampView],
  );

  const initializeToFit = useCallback(() => {
    const fit = computeFit();
    fitRef.current = fit;
    if (naturalRef.current.width > 0 && sizeRef.current.width > 0) {
      initializedRef.current = true;
      fitModeRef.current = true;
      setViewImmediate({ scale: fit, x: 0, y: 0 });
    }
  }, [computeFit, setViewImmediate]);

  const zoomBy = useCallback(
    (factor: number) => {
      const target = targetRef.current;
      const scale = Math.min(maxScale(), Math.max(minScale(), target.scale * factor));
      if (Math.abs(scale - target.scale) < 0.0001) return;
      const ratio = scale / target.scale;
      fitModeRef.current = false;
      animateTo({ scale, x: target.x * ratio, y: target.y * ratio });
    },
    [animateTo, maxScale, minScale],
  );

  const fitToScreen = useCallback(() => {
    const fit = computeFit();
    fitRef.current = fit;
    fitModeRef.current = true;
    animateTo({ scale: fit, x: 0, y: 0 }, 240);
  }, [animateTo, computeFit]);

  const showActualSize = useCallback(() => {
    fitModeRef.current = false;
    animateTo({ scale: 1, x: 0, y: 0 }, 240);
  }, [animateTo]);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (dragRef.current) return;
      const element = viewportRef.current;
      if (!element || naturalRef.current.width <= 0) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const target = targetRef.current;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const scale = Math.min(maxScale(), Math.max(minScale(), target.scale * Math.exp(-delta * 0.0015)));
      if (Math.abs(scale - target.scale) < 0.0001) return;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const contentX = (pointerX - centerX - target.x) / target.scale;
      const contentY = (pointerY - centerY - target.y) / target.scale;
      fitModeRef.current = false;
      animateTo({
        scale,
        x: pointerX - centerX - contentX * scale,
        y: pointerY - centerY - contentY * scale,
      }, 110);
    },
    [animateTo, maxScale, minScale],
  );
  wheelRef.current = handleWheel;

  // Native non-passive listener: React's wheel handler is passive, so it
  // cannot keep the page from scrolling while zooming.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: rect.height };
      if (!initializedRef.current) {
        initializeToFit();
        return;
      }
      const fit = computeFit();
      fitRef.current = fit;
      if (fitModeRef.current) {
        setViewImmediate({ scale: fit, x: 0, y: 0 });
      } else {
        const current = viewRef.current;
        setViewImmediate({ scale: current.scale, x: current.x, y: current.y });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [computeFit, initializeToFit, setViewImmediate]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const markImageLoaded = useCallback((imageElement: HTMLImageElement) => {
    const width = imageElement.naturalWidth || naturalRef.current.width;
    const height = imageElement.naturalHeight || naturalRef.current.height;
    setLoaded(true);
    setFailed(false);
    if (width > 0 && height > 0 && (width !== naturalRef.current.width || height !== naturalRef.current.height)) {
      naturalRef.current = { width, height };
      setNatural({ width, height });
    }
    if (!initializedRef.current) {
      initializeToFit();
      return;
    }
    if (fitModeRef.current) {
      const fit = computeFit();
      fitRef.current = fit;
      setViewImmediate({ scale: fit, x: 0, y: 0 });
    } else {
      setViewImmediate(viewRef.current);
    }
  }, [computeFit, initializeToFit, setViewImmediate]);

  // A memory-cached image can finish before React attaches its load handler.
  // Fit and reveal that image during layout, before the first visible frame.
  useLayoutEffect(() => {
    const element = imageRef.current;
    if (!element) return;
    element.fetchPriority = "high";
    if (element.complete && element.naturalWidth > 0) markImageLoaded(element);
  }, [imageUrl, markImageLoaded]);

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => markImageLoaded(event.currentTarget);

  const handleImageError = () => {
    setFailed(true);
    setLoaded(false);
    onError("图片载入失败");
  };

  const handleDoubleClick = () => {
    const fit = computeFit();
    const current = viewRef.current;
    const nearFit = Math.abs(current.scale - fit) <= Math.max(0.005, fit * 0.01);
    if (nearFit) showActualSize();
    else fitToScreen();
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    animationRef.current = null;
    targetRef.current = viewRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampView({
      scale: viewRef.current.scale,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
    viewRef.current = next;
    targetRef.current = next;
    applyView(next);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dimensionText =
    natural.width > 0 && natural.height > 0
      ? `${natural.width} × ${natural.height}`
      : image && (image.width > 0 || image.height > 0)
        ? `${image.width} × ${image.height}`
        : "尺寸未知";

  const zoomToolbar = (
    <div className={`cp-image-toolbar${toolbarHost !== undefined ? " is-topbar" : ""}`} role="toolbar" aria-label="图片缩放">
      <button type="button" title="缩小" aria-label="缩小" onClick={() => zoomBy(1 / ZOOM_STEP)}><IconMinus size={15} /></button>
      <span ref={percentLabelRef} className="cp-image-percent">{Math.round(viewRef.current.scale * 100)}%</span>
      <button type="button" title="放大" aria-label="放大" onClick={() => zoomBy(ZOOM_STEP)}><IconPlus size={15} /></button>
      <span className="cp-image-toolbar-separator" />
      <button type="button" title="适应窗口" aria-label="适应窗口" onClick={fitToScreen}><IconFit size={15} /><span>适应</span></button>
      <button type="button" title="原始大小" aria-label="原始大小" onClick={showActualSize}>1:1</button>
    </div>
  );

  return (
    <div className="cp-image-page">
      {toolbarHost === undefined && !compact && <div className="cp-image-meta">
        <span className="cp-image-name" title={image?.fileName ?? content.preview}>
          {image?.fileName ?? content.preview}
        </span>
        <span className="cp-meta-dot">·</span>
        <span>{dimensionText}</span>
        {image && image.byteSize > 0 ? (
          <>
            <span className="cp-meta-dot">·</span>
            <span>{formatByteSize(image.byteSize)}</span>
          </>
        ) : null}
      </div>}
      <div
        ref={viewportRef}
        className={`cp-image-viewport${dragging ? " is-dragging" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={handleDoubleClick}
      >
        <div
          ref={stageRef}
          className={`cp-image-stage${natural.width > 0 && natural.height > 0 ? "" : " is-pending"}`}
          style={{ width: natural.width || 1, height: natural.height || 1 }}
        >
          <img
            ref={imageRef}
            className={`cp-image${loaded ? " is-loaded" : ""}`}
            src={imageUrl}
            alt={image?.fileName ?? "图片"}
            draggable={false}
            decoding="async"
            loading="eager"
            style={{ transition: "none" }}
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
        </div>
        <div className={`cp-image-loading${loaded || failed ? " is-done" : ""}`} aria-hidden="true" hidden={loaded || failed} />
        {failed ? (
          <div className="cp-image-failed motion-fade" data-motion="enter" role="alert">
            <strong>图片载入失败</strong>
            <span>{image?.fileName ?? content.preview}</span>
          </div>
        ) : null}
      </div>
      {toolbarHost ? createPortal(zoomToolbar, toolbarHost) : toolbarHost === undefined ? zoomToolbar : null}
    </div>
  );
}
