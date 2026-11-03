import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, ContentRecord } from '../../../shared/image-board';
import { ColorPicker } from '../ui/ColorPicker';
import type { ContentPageApi } from './page-types';
import { compositeImageLayers, encodeImage, imageRect, renderImageEditLayers, type ImageAnnotation, type ImageEdit, type ImageEditLayers, type ImageFormat, type ImagePoint, type ImageRect } from './image-editing';
import './image-editor.css';

type Tool = 'pen' | 'eraser' | 'arrow' | 'rectangle' | 'text' | 'crop' | 'mosaic';
type IconName = Tool | 'undo' | 'redo' | 'rotate' | 'flip' | 'cancel' | 'export' | 'save' | 'check';
const TOOLS: Array<[Tool, string]> = [['pen', '画笔'], ['eraser', '橡皮擦'], ['arrow', '箭头'], ['rectangle', '方框'], ['text', '文字'], ['crop', '裁剪'], ['mosaic', '马赛克']];
const ICON_PATHS: Record<IconName, string> = {
  pen: 'm4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4M4 16l4 4',
  eraser: 'm14 3 7 7-10 10H7l-5-5L14 3Zm-7 7 7 7M11 20h11',
  arrow: 'M4 20 20 4M8 4h12v12', rectangle: 'M4 5h16v14H4z',
  text: 'M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3', crop: 'M7 3v14h14M3 7h14v14',
  mosaic: 'M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z',
  undo: 'm8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12', redo: 'm16 5 5 5-5 5M21 10h-11a6 6 0 0 0 0 12',
  rotate: 'M20 8a8 8 0 1 0 0 9M20 3v5h-5', flip: 'M12 3v18M8 6 2 18h6V6Zm8 0 6 12h-6V6Z',
  cancel: 'm6 6 12 12M18 6 6 18', export: 'M12 15V3m-4 4 4-4 4 4M4 14v6h16v-6',
  save: 'M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8', check: 'm5 12 4 4L19 6',
};
function EditorIcon({ name }: { name: IconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}
function AnnotationColorControl({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // ColorPicker exposes no trigger label prop; keep this adaptation local.
    const trigger = root.current?.querySelector('button');
    trigger?.setAttribute('aria-label', '批注颜色'); trigger?.setAttribute('title', '批注颜色');
  }, []);
  return <div ref={root} className="ime-color-control"><ColorPicker value={value} onChange={onChange} label="批注颜色" disabled={disabled} /></div>;
}
interface Props {
  content: ContentRecord;
  /** Compatibility only: controls now live below the image. */
  toolbarHost?: HTMLElement | null;
  apiRef: React.MutableRefObject<ContentPageApi>;
  onCancel(): void;
  onSaved(result: { state: AppState; contentId: string }): Promise<void> | void;
  onError(message: string): void;
  onNotice(message: string): void;
}

export function ImageEditor(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(44);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const layersRef = useRef<ImageEditLayers | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#E5484D');
  const [size, setSize] = useState(8);
  const [eraserSize, setEraserSize] = useState(36);
  const [eraserPoint, setEraserPoint] = useState<ImagePoint | null>(null);
  const [text, setText] = useState('');
  const [textSize, setTextSize] = useState(36);
  const [format, setFormat] = useState<ImageFormat>('png');
  const [quality, setQuality] = useState(0.92);
  const [history, setHistory] = useState<ImageEdit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<ImagePoint[] | null>(null);
  const draftRef = useRef<ImagePoint[] | null>(null);
  const activePointer = useRef<number | null>(null);
  const [crop, setCrop] = useState<ImageRect | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingCloseRef = useRef<((accepted: boolean) => void) | null>(null);
  const dirty = cursor > 0;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty || Boolean(draft || crop);
  const requestCancel = () => { if (busyRef.current) return; if (dirty || draft || crop) setConfirmDiscard(true); else props.onCancel(); };
  const cancelRef = useRef(requestCancel); cancelRef.current = requestCancel;

  useEffect(() => {
    const close = () => { cancelRef.current(); return true; };
    const beforeClose = () => {
      if (busyRef.current) return false;
      if (!dirtyRef.current) return true;
      setConfirmDiscard(true);
      return new Promise<boolean>((resolve) => { pendingCloseRef.current?.(false); pendingCloseRef.current = resolve; });
    };
    props.apiRef.current.closePopups = close;
    props.apiRef.current.beforeClose = beforeClose;
    return () => { if (props.apiRef.current.closePopups === close) delete props.apiRef.current.closePopups; if (props.apiRef.current.beforeClose === beforeClose) delete props.apiRef.current.beforeClose; pendingCloseRef.current?.(false); };
  }, [props.apiRef]);

  useEffect(() => {
    let cancelled = false, objectUrl: string | null = null;
    setReady(false); setError(''); setHistory([]); setCursor(0); setCrop(null); setDraft(null);
    imageRef.current = null; layersRef.current = null; draftRef.current = null; activePointer.current = null; setEraserPoint(null);
    window.imageBoard.readImage(props.content.id).then(({ data, mime }) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
      const image = new Image();
      image.onload = () => { if (!cancelled) { imageRef.current = image; setReady(true); } };
      image.onerror = () => { if (!cancelled) setError('图片解码失败'); };
      image.src = objectUrl;
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : '图片读取失败'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [props.content.id]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => { const rect = node.getBoundingClientRect(); setViewport({ width: rect.width, height: rect.height }); setDockHeight(dockRef.current?.getBoundingClientRect().height ?? 44); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); if (dockRef.current) observer.observe(dockRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!ready || !image) return;
    const layers = renderImageEditLayers(image, image.naturalWidth, image.naturalHeight, history.slice(0, cursor));
    layersRef.current = layers;
    setDimensions({ width: layers.base.width, height: layers.base.height });
    setEraserPoint(null);
  }, [ready, history, cursor]);

  useEffect(() => {
    const layers = layersRef.current, target = canvasRef.current;
    if (!ready || !layers || !target) return;
    let preview: ImageAnnotation | undefined;
    if (draft && (tool === 'pen' || tool === 'arrow' || tool === 'rectangle')) preview = { kind: tool, points: draft, color, size };
    if (draft && tool === 'eraser') preview = { kind: 'eraser', points: draft, size: eraserSize };
    const output = compositeImageLayers(layers, preview);
    if (target.width !== output.width) target.width = output.width;
    if (target.height !== output.height) target.height = output.height;
    const context = target.getContext('2d')!;
    context.clearRect(0, 0, target.width, target.height); context.drawImage(output, 0, 0);
  }, [ready, history, cursor, draft, tool, color, size, eraserSize]);

  const commit = useCallback((edit: ImageEdit) => {
    setHistory((previous) => [...previous.slice(0, cursor), edit]); setCursor(cursor + 1); setCrop(null);
  }, [cursor]);
  const pointAt = (event: { clientX: number; clientY: number }): ImagePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
  };
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || busy || event.button !== 0 || activePointer.current !== null) return;
    const point = pointAt(event);
    if (tool === 'text') {
      if (!text.trim()) { props.onNotice('先在下方输入文字，再点击图片放置'); return; }
      commit({ kind: 'text', point, text, color, size: textSize }); return;
    }
    event.currentTarget.setPointerCapture(event.pointerId); activePointer.current = event.pointerId;
    draftRef.current = [point]; setDraft([point]); setCrop(null);
    if (tool === 'eraser') setEraserPoint(point);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool === 'eraser' && ready && !busy) setEraserPoint(pointAt(event));
    if (activePointer.current !== event.pointerId || !draftRef.current) return;
    const previous = draftRef.current;
    // Keep curved brush paths and high-frequency tablet samples.
    const samples = tool === 'pen' || tool === 'eraser'
      ? (event.nativeEvent.getCoalescedEvents?.() ?? []).map((sample) => pointAt(sample))
      : [];
    const point = pointAt(event);
    const next = tool === 'pen' || tool === 'eraser' ? [...previous, ...samples, point] : [previous[0], point];
    draftRef.current = next; setDraft(next);
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== event.pointerId || !draftRef.current) return;
    const points = [...draftRef.current, pointAt(event)];
    activePointer.current = null; draftRef.current = null; setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (tool === 'crop' || tool === 'mosaic') {
      const rect = imageRect(points[0], points.at(-1)!, dimensions.width, dimensions.height);
      if (rect.width < 2 || rect.height < 2) return;
      if (tool === 'crop') setCrop(rect); else commit({ kind: 'mosaic', rect, size: Math.max(8, size * 2) });
    } else if (tool === 'eraser') commit({ kind: 'eraser', points, size: eraserSize });
    else if (tool !== 'text') commit({ kind: tool, points, color, size });
  };
  const cancelPointer = () => { activePointer.current = null; draftRef.current = null; setDraft(null); };
  const finishDiscard = (accepted: boolean) => { setConfirmDiscard(false); const resolve = pendingCloseRef.current; pendingCloseRef.current = null; resolve?.(accepted); if (accepted) props.onCancel(); };
  const save = async (exportFile: boolean) => {
    if (!ready || busy || !canvasRef.current || crop || draft) return;
    setBusy(true);
    try {
      const payload = await encodeImage(canvasRef.current, format, props.content.image?.fileName ?? '图片.png', quality);
      if (exportFile) { const path = await window.imageBoard.exportImage(payload); if (path) props.onNotice('图片已导出'); }
      else { const result = await window.imageBoard.saveImageCopy(payload); await props.onSaved(result); }
    } catch (caught) { props.onError(caught instanceof Error ? caught.message : '图片保存失败'); }
    finally { setBusy(false); }
  };
  const locked = !ready || busy;
  const brushLabel = tool === 'eraser' ? '橡皮擦大小' : tool === 'mosaic' ? '马赛克大小' : '批注粗细';
  const scale = Math.max(0.001, Math.min(Math.max(1, viewport.width - 40) / dimensions.width, Math.max(1, viewport.height - dockHeight - 64) / dimensions.height, 1));
  const selection = crop ?? (draft && (tool === 'crop' || tool === 'mosaic') ? imageRect(draft[0], draft.at(-1)!, dimensions.width, dimensions.height) : null);
  const hint = tool === 'text' ? '点击图片放置文字' : tool === 'crop' ? '拖出裁剪范围，再点应用裁剪' : tool === 'eraser' ? '拖动擦除本次批注，保留底图' : '在图片上拖动绘制';
  return <div className="ime-editor">
    <div ref={viewportRef} className="ime-workspace" style={{ paddingBottom: dockHeight + 52 }}>
      {!ready && <div className="ime-status" role={error ? 'alert' : 'status'}>{error || '正在读取图片…'}</div>}
      <div className="ime-surface" style={{ width: dimensions.width * scale, height: dimensions.height * scale, visibility: ready ? 'visible' : 'hidden' }}>
        <canvas ref={canvasRef} className={tool === 'eraser' ? 'is-erasing' : undefined} aria-label="图片编辑画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} onPointerLeave={() => { if (activePointer.current === null) setEraserPoint(null); }} />
        <svg className="ime-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} aria-hidden="true">
          {selection && <rect {...selection} fill={tool === 'mosaic' ? '#7778' : 'transparent'} stroke="var(--accent)" strokeWidth={2 / scale} strokeDasharray={tool === 'crop' ? `${6 / scale} ${4 / scale}` : undefined} />}
          {tool === 'eraser' && eraserPoint && <g data-testid="ime-eraser-cursor"><circle cx={eraserPoint.x} cy={eraserPoint.y} r={eraserSize / 2} fill="#ffffff14" stroke="#0009" strokeWidth={3 / scale} /><circle cx={eraserPoint.x} cy={eraserPoint.y} r={eraserSize / 2} fill="none" stroke="#fff" strokeWidth={1.25 / scale} /></g>}
        </svg>
      </div>
      <span className="ime-hint" style={{ bottom: dockHeight + 24 }}>{dimensions.width} × {dimensions.height} · {hint} · 保存副本保留原图</span>
    </div>
    <div ref={dockRef} className="ime-dock">
      <div className="ime-toolbar" aria-label="图像编辑工具" role="toolbar">
        <div className="ime-capsule ime-tools" role="group" aria-label="绘图工具">
          {TOOLS.map(([id, label]) => <button type="button" className="ime-icon-button" key={id} aria-label={label} title={label} aria-pressed={tool === id} onClick={() => { cancelPointer(); setTool(id); setCrop(null); setEraserPoint(null); }} disabled={locked}><EditorIcon name={id} /></button>)}
        </div>
        <div className="ime-capsule" role="group" aria-label="历史与变换">
          <button type="button" className="ime-icon-button" aria-label="撤销" title="撤销" onClick={() => { setCursor((value) => value - 1); setCrop(null); }} disabled={cursor === 0 || busy}><EditorIcon name="undo" /></button>
          <button type="button" className="ime-icon-button" aria-label="重做" title="重做" onClick={() => { setCursor((value) => value + 1); setCrop(null); }} disabled={cursor === history.length || busy}><EditorIcon name="redo" /></button>
          <span className="ime-divider" />
          <button type="button" className="ime-icon-button" aria-label="旋转" title="顺时针旋转 90°" onClick={() => commit({ kind: 'rotate' })} disabled={locked}><EditorIcon name="rotate" /></button>
          <button type="button" className="ime-icon-button" aria-label="翻转" title="水平翻转" onClick={() => commit({ kind: 'flip' })} disabled={locked}><EditorIcon name="flip" /></button>
        </div>
        {(tool !== 'crop' || crop) && <div className="ime-capsule ime-properties" role="group" aria-label="工具属性">
          {tool !== 'eraser' && tool !== 'mosaic' && tool !== 'crop' && <AnnotationColorControl value={color} onChange={setColor} disabled={locked} />}
          {tool !== 'text' && tool !== 'crop' && <label className="ime-size" title={brushLabel}><span>{tool === 'mosaic' ? '色块' : '大小'}</span><input aria-label={brushLabel} type="range" min={tool === 'eraser' ? 4 : 2} max={tool === 'eraser' ? 160 : 48} value={tool === 'eraser' ? eraserSize : size} disabled={locked} onChange={(event) => (tool === 'eraser' ? setEraserSize : setSize)(Number(event.target.value))} /><output>{tool === 'eraser' ? eraserSize : tool === 'mosaic' ? Math.max(8, size * 2) : size}</output></label>}
          {tool === 'text' && <><input className="ime-text" aria-label="批注文字" placeholder="输入文字，点击图片放置" value={text} disabled={locked} onChange={(event) => setText(event.target.value)} /><input className="ime-text-size" type="number" aria-label="文字大小" title="文字大小" min="8" max="300" value={textSize} disabled={locked} onChange={(event) => setTextSize(Math.max(8, Math.min(300, Number(event.target.value) || 8)))} /></>}
          {crop && <button type="button" className="ime-primary" onClick={() => commit({ kind: 'crop', rect: crop })} disabled={locked}><EditorIcon name="check" />应用裁剪</button>}
        </div>}
        <div className="ime-capsule ime-save-actions" role="group" aria-label="保存与导出">
          <button type="button" className="ime-icon-button" aria-label="取消" title="取消编辑" onClick={requestCancel} disabled={busy}><EditorIcon name="cancel" /></button>
          <select aria-label="导出格式" title="导出格式" value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)} disabled={busy}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select>
          {format !== 'png' && <select aria-label="导出质量" title="导出质量" value={quality} disabled={busy} onChange={(event) => setQuality(Number(event.target.value))}><option value="0.92">高质量</option><option value="0.8">标准</option><option value="0.6">小文件</option></select>}
          <button type="button" className="ime-icon-button" aria-label="导出文件" title="导出文件" onClick={() => void save(true)} disabled={locked || Boolean(crop || draft)}><EditorIcon name="export" /></button>
          <button type="button" className="ime-primary" onClick={() => void save(false)} disabled={locked || Boolean(crop || draft)}><EditorIcon name="save" />{busy ? '保存中…' : '保存副本'}</button>
        </div>
      </div>
    </div>
    {confirmDiscard && <div className="ime-discard" data-esc-layer role="alertdialog" aria-label="放弃图片编辑"><span>放弃未保存的修改？</span><button type="button" onClick={() => finishDiscard(false)}>继续编辑</button><button type="button" onClick={() => finishDiscard(true)}>放弃修改</button></div>}
  </div>;
}
