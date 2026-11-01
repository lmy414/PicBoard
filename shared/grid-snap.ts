import type { GridSize } from "./image-board";

/**
 * Canvas grid snapping (pure, neutral module).
 *
 * The renderer snaps the dragged set's top-left live so it can preview the
 * host's placement before the final `moveNodes`/`setCanvasFrame` call. The host
 * remains authoritative: it re-snaps and relocates to avoid overlaps.
 */

/** Alt inverts the configured snap mode for the duration of one gesture. */
export function isSnapActive(snapToGrid: boolean, altKey: boolean): boolean {
  return altKey ? !snapToGrid : snapToGrid;
}

/** Round one world coordinate to the nearest grid line (negative values included). */
export function snapCoordinate(value: number, gridSize: GridSize | number): number {
  const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 24;
  const snapped = Math.round(value / size) * size;
  // Normalize -0 so tests and host comparisons see a plain zero.
  return snapped === 0 ? 0 : snapped;
}

/** Snap a world point to the nearest grid intersection. */
export function snapPoint(point: { x: number; y: number }, gridSize: GridSize | number): { x: number; y: number } {
  return { x: snapCoordinate(point.x, gridSize), y: snapCoordinate(point.y, gridSize) };
}

/**
 * Delta that lands the set's `origin` (its bounding top-left) on the nearest
 * grid intersection. Free mode passes the raw delta through untouched.
 */
export function snappedDelta(
  origin: { x: number; y: number },
  delta: { x: number; y: number },
  gridSize: GridSize | number,
  active: boolean,
): { x: number; y: number } {
  if (!active) return { x: delta.x, y: delta.y };
  const target = snapPoint({ x: origin.x + delta.x, y: origin.y + delta.y }, gridSize);
  return { x: target.x - origin.x, y: target.y - origin.y };
}
