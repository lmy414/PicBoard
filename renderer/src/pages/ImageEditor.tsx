import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppState, ContentRecord } from '../../../shared/image-board';
import { ColorPicker } from '../ui/ColorPicker';
import type { ContentPageApi } from './page-types';
import { encodeImage, imageRect, renderImageEdits, type ImageEdit, type ImageFormat, type ImagePoint, type ImageRect } from './image-editing';
import './image-editor.css';

type Tool = 'pen' | 'arrow' | 'rectangle' | 'text' | 'crop' | 'mosaic';
const TOOLS: Array<[Tool, string]> = [['pen', '画笔'], ['arrow', '箭头'], ['rectangle', '方框'], ['text', '文字'], ['crop', '裁剪'], ['mosaic', '马赛克']];
interface Props {
  content: ContentRecord;
  toolbarHost: HTMLElement | null | undefined;
  apiRef: React.MutableRefObject<ContentPageApi>;
  onCancel(): void;
  onSaved(result: { state: AppState; contentId: string }): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

export function ImageEditor(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#E5484D');
  const [size, setSize] = useState(8);
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingCloseRef = useRef<((accepted: boolean) => void) | null>(null);
  const dirty = cursor > 0;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty || Boolean(draft || crop);
  const requestCancel = () => { if (dirty || draft || crop) setConfirmDiscard(true); else props.onCancel(); };
  const cancelRef = useRef(requestCancel); cancelRef.current = requestCancel;

  useEffect(() => {
    const close = () => { cancelRef.current(); return true; };
    const beforeClose = () => {
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
    const measure = () => { const rect = node.getBoundingClientRect(); setViewport({ width: rect.width, height: rect.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const image = imageRef.current, target = canvasRef.current;
    if (!ready || !image || !target) return;
    const output = renderImageEdits(image, image.naturalWidth, image.naturalHeight, history.slice(0, cursor));
    target.width = output.width; target.height = output.height;
    target.getContext('2d')!.drawImage(output, 0, 0);
    setDimensions({ width: output.width, height: output.height });
  }, [ready, history, cursor]);

  const commit = useCallback((edit: ImageEdit) => {
    setHistory((previous) => [...previous.slice(0, cursor), edit]); setCursor(cursor + 1); setCrop(null);
  }, [cursor]);
  const pointAt = (event: React.PointerEvent): ImagePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
  };
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || busy || event.button !== 0) return;
    const point = pointAt(event);
    if (tool === 'text') {
      if (!text.trim()) { props.onNotice('先在顶部输入文字，再点击图片放置'); return; }
      commit({ kind: 'text', point, text, color, size: textSize }); return;
    }
    event.currentTarget.setPointerCapture(event.pointerId); activePointer.current = event.pointerId;
    draftRef.current = [point]; setDraft([point]); setCrop(null);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== event.pointerId || !draftRef.current) return;
    const point = pointAt(event), previous = draftRef.current;
    const next = tool === 'pen' ? [...previous, point] : [previous[0], point];
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
    } else if (tool !== 'text') commit({ kind: tool, points, color, size });
  };
  const cancelPointer = () => { activePointer.current = null; draftRef.current = null; setDraft(null); };
  const finishDiscard = (accepted: boolean) => { setConfirmDiscard(false); const resolve = pendingCloseRef.current; pendingCloseRef.current = null; resolve?.(accepted); if (accepted) props.onCancel(); };

  const save = async (exportFile: boolean) => {
    if (!ready || busy || !canvasRef.current || crop || draft) return;
    setBusy(true);
    try {
      const payload = await encodeImage(canvasRef.current, format, props.content.image?.fileName ?? '图片.png', quality);
      if (exportFile) { const path = await window.imageBoard.exportImage(payload); if (path) props.onNotice('图片已导出'); }
      else { const result = await window.imageBoard.saveImageCopy(payload); props.onSaved(result); }
    } catch (caught) { props.onError(caught instanceof Error ? caught.message : '图片保存失败'); }
    finally { setBusy(false); }
  };

  const toolbar = <div className="ime-toolbar" aria-label="图像编辑工具" role="toolbar">
    <button type="button" onClick={requestCancel} disabled={busy}>取消</button>
    <div className="ime-toolbar-fields">
      <div className="ime-tools" role="group" aria-label="编辑工具">{TOOLS.map(([id, label]) => <button type="button" key={id} aria-pressed={tool === id} onClick={() => { setTool(id); setCrop(null); }} disabled={!ready || busy}>{label}</button>)}</div>
      <ColorPicker value={color} onChange={setColor} label="批注颜色" disabled={busy} />
      <label className="ime-size">粗细<input aria-label="批注粗细" type="range" min="2" max="48" value={size} onChange={(event) => setSize(Number(event.target.value))} /></label>
      {tool === 'text' && <><input className="ime-text" aria-label="批注文字" placeholder="输入文字，点击图片放置" value={text} onChange={(event) => setText(event.target.value)} /><input className="ime-text-size" type="number" aria-label="文字大小" min="8" max="300" value={textSize} onChange={(event) => setTextSize(Math.max(8, Math.min(300, Number(event.target.value) || 8)))} /></>}
      {crop && <button type="button" className="ime-primary" onClick={() => commit({ kind: 'crop', rect: crop })}>应用裁剪</button>}
      <button type="button" onClick={() => { setCursor((value) => value - 1); setCrop(null); }} disabled={cursor === 0 || busy}>撤销</button>
      <button type="button" onClick={() => { setCursor((value) => value + 1); setCrop(null); }} disabled={cursor === history.length || busy}>重做</button>
      <button type="button" onClick={() => commit({ kind: 'rotate' })} disabled={!ready || busy}>旋转</button>
      <button type="button" onClick={() => commit({ kind: 'flip' })} disabled={!ready || busy}>翻转</button>
    </div>
    <div className="ime-save-actions">
      <select aria-label="导出格式" value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)} disabled={busy}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select>
      {format !== 'png' && <select aria-label="导出质量" value={quality} onChange={(event) => setQuality(Number(event.target.value))}><option value="0.92">高质量</option><option value="0.8">标准</option><option value="0.6">小文件</option></select>}
      <button type="button" onClick={() => void save(true)} disabled={!ready || busy || Boolean(crop || draft)}>导出文件</button>
      <button type="button" className="ime-primary" onClick={() => void save(false)} disabled={!ready || busy || Boolean(crop || draft)}>{busy ? '保存中…' : '保存副本'}</button>
    </div>
  </div>;
  const scale = Math.max(0.01, Math.min((viewport.width - 40) / dimensions.width, (viewport.height - 40) / dimensions.height, 1));
  const selection = crop ?? (draft && (tool === 'crop' || tool === 'mosaic' || tool === 'rectangle') ? imageRect(draft[0], draft.at(-1)!, dimensions.width, dimensions.height) : null);
  return <div className="ime-editor">
    {props.toolbarHost ? createPortal(toolbar, props.toolbarHost) : props.toolbarHost === undefined ? toolbar : null}
    <div ref={viewportRef} className="ime-workspace">
      {!ready && <div className="ime-status" role={error ? 'alert' : 'status'}>{error || '正在读取图片…'}</div>}
      <div className="ime-surface" style={{ width: dimensions.width * scale, height: dimensions.height * scale, visibility: ready ? 'visible' : 'hidden' }}>
        <canvas ref={canvasRef} aria-label="图片编辑画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} />
        <svg className="ime-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} aria-hidden="true">
          {selection && <rect {...selection} fill={tool === 'mosaic' ? '#7778' : 'transparent'} stroke={tool === 'rectangle' ? color : '#27866c'} strokeWidth={tool === 'rectangle' ? size : 2 / scale} strokeDasharray={tool === 'crop' ? `${6 / scale} ${4 / scale}` : undefined} />}
          {draft && (tool === 'pen' || tool === 'arrow') && <polyline points={draft.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={color} strokeWidth={size} strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>
      <span className="ime-hint">{dimensions.width} × {dimensions.height} · {tool === 'text' ? '点击图片放置文字' : tool === 'crop' ? '拖出裁剪范围，再点“应用裁剪”' : '在图片上拖动绘制'} · 保存副本保留原图</span>
    </div>
    {confirmDiscard && <div className="ime-discard" data-esc-layer role="alertdialog" aria-label="放弃图片编辑"><span>放弃未保存的修改？</span><button type="button" onClick={() => finishDiscard(false)}>继续编辑</button><button type="button" onClick={() => finishDiscard(true)}>放弃修改</button></div>}
  </div>;
}
