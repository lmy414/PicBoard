export interface ImagePoint { x: number; y: number }
export interface ImageRect { x: number; y: number; width: number; height: number }
export type ImageEdit =
  | { kind: 'pen' | 'arrow' | 'rectangle'; points: ImagePoint[]; color: string; size: number }
  | { kind: 'text'; point: ImagePoint; text: string; color: string; size: number }
  | { kind: 'crop'; rect: ImageRect }
  | { kind: 'mosaic'; rect: ImageRect; size?: number }
  | { kind: 'rotate' }
  | { kind: 'flip' };
export type ImageFormat = 'png' | 'jpeg' | 'webp';

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

/** Replay vector operations, keeping undo history independent of image size. */
export function renderImageEdits(source: CanvasImageSource, width: number, height: number, edits: ImageEdit[]): HTMLCanvasElement {
  let output = canvas(width, height);
  output.getContext('2d')!.drawImage(source, 0, 0, width, height);
  for (const edit of edits) {
    if (edit.kind === 'crop') {
      const { x, y, width, height } = edit.rect;
      if (width < 1 || height < 1) continue;
      const next = canvas(width, height);
      next.getContext('2d')!.drawImage(output, x, y, width, height, 0, 0, width, height);
      output = next; continue;
    }
    if (edit.kind === 'rotate' || edit.kind === 'flip') {
      const next = canvas(edit.kind === 'rotate' ? output.height : output.width, edit.kind === 'rotate' ? output.width : output.height);
      const context = next.getContext('2d')!;
      if (edit.kind === 'rotate') { context.translate(next.width, 0); context.rotate(Math.PI / 2); }
      else { context.translate(next.width, 0); context.scale(-1, 1); }
      context.drawImage(output, 0, 0); output = next; continue;
    }
    const context = output.getContext('2d')!;
    if (edit.kind === 'mosaic') {
      const { x, y, width, height } = edit.rect;
      if (width < 1 || height < 1) continue;
      const block = Math.max(4, edit.size ?? 16);
      const sample = canvas(Math.max(1, Math.ceil(width / block)), Math.max(1, Math.ceil(height / block)));
      sample.getContext('2d')!.drawImage(output, x, y, width, height, 0, 0, sample.width, sample.height);
      context.save(); context.imageSmoothingEnabled = false;
      context.clearRect(x, y, width, height);
      context.drawImage(sample, 0, 0, sample.width, sample.height, x, y, width, height);
      context.restore(); continue;
    }
    context.fillStyle = edit.color; context.strokeStyle = edit.color;
    if (edit.kind === 'text') {
      context.font = `${edit.size}px "Microsoft YaHei", sans-serif`;
      context.textBaseline = 'top';
      edit.text.split('\n').forEach((line, index) => context.fillText(line, edit.point.x, edit.point.y + index * edit.size * 1.3));
      continue;
    }
    const first = edit.points[0], last = edit.points.at(-1);
    if (!first || !last) continue;
    context.lineWidth = edit.size; context.lineCap = 'round'; context.lineJoin = 'round';
    if (edit.kind === 'rectangle') {
      const rect = imageRect(first, last, output.width, output.height);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      continue;
    }
    context.beginPath(); context.moveTo(first.x, first.y);
    for (const point of edit.points.slice(1)) context.lineTo(point.x, point.y);
    if (edit.points.length === 1) context.lineTo(first.x + 0.01, first.y);
    context.stroke();
    if (edit.kind === 'arrow') {
      const angle = Math.atan2(last.y - first.y, last.x - first.x), length = Math.max(14, edit.size * 4);
      context.beginPath(); context.moveTo(last.x, last.y);
      context.lineTo(last.x - length * Math.cos(angle - Math.PI / 6), last.y - length * Math.sin(angle - Math.PI / 6));
      context.lineTo(last.x - length * Math.cos(angle + Math.PI / 6), last.y - length * Math.sin(angle + Math.PI / 6));
      context.closePath(); context.fill();
    }
  }
  return output;
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
