export interface ImagePoint { x: number; y: number }
export interface ImageRect { x: number; y: number; width: number; height: number }
export type ImageAnnotation =
  | { kind: 'pen' | 'arrow' | 'rectangle'; points: ImagePoint[]; color: string; size: number }
  | { kind: 'eraser'; points: ImagePoint[]; size: number }
  | { kind: 'text'; point: ImagePoint; text: string; color: string; size: number }
  | { kind: 'mosaic'; rect: ImageRect; size?: number };
export type ImageEdit = ImageAnnotation
  | { kind: 'crop'; rect: ImageRect }
  | { kind: 'rotate' }
  | { kind: 'flip' };
export type ImageFormat = 'png' | 'jpeg' | 'webp';

/** Coverage also records transparent mosaic pixels, which must replace the base. */
export interface ImageEditLayers {
  base: HTMLCanvasElement;
  annotations: HTMLCanvasElement;
  coverage: HTMLCanvasElement;
}

export function imageRect(a: ImagePoint, b: ImagePoint, width: number, height: number): ImageRect {
  const left = Math.max(0, Math.min(width, Math.floor(Math.min(a.x, b.x))));
  const top = Math.max(0, Math.min(height, Math.floor(Math.min(a.y, b.y))));
  const right = Math.max(left, Math.min(width, Math.ceil(Math.max(a.x, b.x))));
  const bottom = Math.max(top, Math.min(height, Math.ceil(Math.max(a.y, b.y))));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function canvas(width: number, height: number) {
  const value = document.createElement('canvas');
  value.width = width; value.height = height;
  return value;
}

function copy(source: HTMLCanvasElement) {
  const output = canvas(source.width, source.height);
  output.getContext('2d')!.drawImage(source, 0, 0);
  return output;
}

function drawAnnotation(context: CanvasRenderingContext2D, edit: Exclude<ImageAnnotation, { kind: 'mosaic' }>, mask: boolean) {
  context.save();
  context.globalCompositeOperation = edit.kind === 'eraser' ? 'destination-out' : 'source-over';
  const color = edit.kind === 'eraser' || mask ? '#ffffff' : edit.color;
  context.fillStyle = color; context.strokeStyle = color;
  if (edit.kind === 'text') {
    context.font = `${edit.size}px "Microsoft YaHei", sans-serif`;
    context.textBaseline = 'top';
    edit.text.split('\n').forEach((line, index) => context.fillText(line, edit.point.x, edit.point.y + index * edit.size * 1.3));
  } else {
    const first = edit.points[0], last = edit.points.at(-1);
    if (first && last) {
      context.lineWidth = edit.size; context.lineCap = 'round'; context.lineJoin = 'round';
      if (edit.kind === 'rectangle') {
        const rect = imageRect(first, last, context.canvas.width, context.canvas.height);
        context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      } else {
        // A click, or a pointer that has not moved, still leaves a round dab.
        if (edit.points.every((point) => point.x === first.x && point.y === first.y)) {
          context.beginPath(); context.arc(first.x, first.y, edit.size / 2, 0, Math.PI * 2); context.fill();
        } else {
          context.beginPath(); context.moveTo(first.x, first.y);
          for (const point of edit.points.slice(1)) context.lineTo(point.x, point.y);
          context.stroke();
        }
        if (edit.kind === 'arrow') {
          const angle = Math.atan2(last.y - first.y, last.x - first.x), length = Math.max(14, edit.size * 4);
          context.beginPath(); context.moveTo(last.x, last.y);
          context.lineTo(last.x - length * Math.cos(angle - Math.PI / 6), last.y - length * Math.sin(angle - Math.PI / 6));
          context.lineTo(last.x - length * Math.cos(angle + Math.PI / 6), last.y - length * Math.sin(angle + Math.PI / 6));
          context.closePath(); context.fill();
        }
      }
    }
  }
  context.restore();
}

function applyAnnotation(layers: ImageEditLayers, edit: ImageAnnotation) {
  if (edit.kind !== 'mosaic') {
    drawAnnotation(layers.annotations.getContext('2d')!, edit, false);
    drawAnnotation(layers.coverage.getContext('2d')!, edit, true);
    return;
  }
  const { x, y, width, height } = edit.rect;
  if (width < 1 || height < 1) return;
  const block = Math.max(4, edit.size ?? 16);
  const sample = canvas(Math.max(1, Math.ceil(width / block)), Math.max(1, Math.ceil(height / block)));
  sample.getContext('2d')!.drawImage(compositeImageLayers(layers), x, y, width, height, 0, 0, sample.width, sample.height);
  const context = layers.annotations.getContext('2d')!;
  context.save(); context.imageSmoothingEnabled = false;
  context.clearRect(x, y, width, height);
  context.drawImage(sample, 0, 0, sample.width, sample.height, x, y, width, height);
  context.restore();
  const coverage = layers.coverage.getContext('2d')!;
  coverage.fillStyle = '#ffffff'; coverage.fillRect(x, y, width, height);
}

/** Composite a cached replay, optionally previewing a mark without mutating history. */
export function compositeImageLayers(layers: ImageEditLayers, preview?: ImageAnnotation): HTMLCanvasElement {
  let visible = layers;
  if (preview) {
    visible = { base: layers.base, annotations: copy(layers.annotations), coverage: copy(layers.coverage) };
    applyAnnotation(visible, preview);
  }
  const output = copy(visible.base), context = output.getContext('2d')!;
  // Add premultiplied contributions after masking the base. Unlike source-over,
  // this preserves transparent mosaic samples and antialiased eraser edges.
  context.globalCompositeOperation = 'destination-out'; context.drawImage(visible.coverage, 0, 0);
  context.globalCompositeOperation = 'lighter'; context.drawImage(visible.annotations, 0, 0);
  context.globalCompositeOperation = 'source-over';
  return output;
}

function transformLayer(source: HTMLCanvasElement, edit: Extract<ImageEdit, { kind: 'crop' | 'rotate' | 'flip' }>) {
  if (edit.kind === 'crop') {
    const { x, y, width, height } = edit.rect;
    const next = canvas(width, height);
    next.getContext('2d')!.drawImage(source, x, y, width, height, 0, 0, width, height);
    return next;
  }
  const next = canvas(edit.kind === 'rotate' ? source.height : source.width, edit.kind === 'rotate' ? source.width : source.height);
  const context = next.getContext('2d')!;
  context.save();
  if (edit.kind === 'rotate') { context.translate(next.width, 0); context.rotate(Math.PI / 2); }
  else { context.translate(next.width, 0); context.scale(-1, 1); }
  context.drawImage(source, 0, 0); context.restore();
  return next;
}

/** Replay edits on independent layers. Erasing can never change the base image. */
export function renderImageEditLayers(source: CanvasImageSource, width: number, height: number, edits: ImageEdit[]): ImageEditLayers {
  let layers: ImageEditLayers = { base: canvas(width, height), annotations: canvas(width, height), coverage: canvas(width, height) };
  layers.base.getContext('2d')!.drawImage(source, 0, 0, width, height);
  for (const edit of edits) {
    if (edit.kind === 'crop' || edit.kind === 'rotate' || edit.kind === 'flip') {
      if (edit.kind === 'crop' && (edit.rect.width < 1 || edit.rect.height < 1)) continue;
      layers = { base: transformLayer(layers.base, edit), annotations: transformLayer(layers.annotations, edit), coverage: transformLayer(layers.coverage, edit) };
    } else applyAnnotation(layers, edit);
  }
  return layers;
}

/** Vector history stays independent of image dimensions, including eraser paths. */
export function renderImageEdits(source: CanvasImageSource, width: number, height: number, edits: ImageEdit[]): HTMLCanvasElement {
  return compositeImageLayers(renderImageEditLayers(source, width, height, edits));
}

export async function encodeImage(source: HTMLCanvasElement, format: ImageFormat, name: string, quality: number) {
  let output = source;
  if (format === 'jpeg') {
    output = canvas(source.width, source.height);
    const context = output.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, output.width, output.height); context.drawImage(source, 0, 0);
  }
  const mime = `image/${format}`;
  const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error('图片编码失败')), mime, quality));
  if (blob.type !== mime) throw new Error('当前系统不支持此导出格式，请选择 PNG');
  return { name: `${name.replace(/\.[^.]+$/, '')}-编辑.${format === 'jpeg' ? 'jpg' : format}`, data: new Uint8Array(await blob.arrayBuffer()) };
}
