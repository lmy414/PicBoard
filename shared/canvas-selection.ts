export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectableImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalize two points into a positive-width/height rectangle. */
export function normalizeSelectionRect(start: { x: number; y: number }, end: { x: number; y: number }): SelectionRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

/** Toggle one item for an additive selection, or replace selection for a normal click. */
export function applySelection(selectedIds: string[], imageId: string, toggleSelection: boolean): string[] {
  if (!toggleSelection) return [imageId];
  return selectedIds.includes(imageId)
    ? selectedIds.filter((id) => id !== imageId)
    : [...selectedIds, imageId];
}

function intersects(a: SelectionRect, b: SelectionRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Return image ids whose bounds touch the selection rectangle. */
export function imagesInSelectionRect(images: SelectableImage[], rect: SelectionRect): string[] {
  return images.filter((image) => intersects(rect, { x: image.x, y: image.y, width: image.width, height: image.height })).map((image) => image.id);
}

/** Replace or append a rectangle result while preserving stable selection order. */
export function mergeSelection(selectedIds: string[], nextIds: string[], toggleSelection: boolean): string[] {
  if (!toggleSelection) return [...nextIds];
  return [...selectedIds, ...nextIds.filter((id) => !selectedIds.includes(id))];
}
