export interface PreviewSize {
  width: number;
  height: number;
}

export interface PreviewPoint {
  x: number;
  y: number;
}

export const MIN_PREVIEW_ZOOM = 1;
export const MAX_PREVIEW_ZOOM = 8;

/** Fit an image inside the measured preview viewport while preserving aspect ratio. */
export function fitPreviewSize(image: PreviewSize, viewport: PreviewSize): PreviewSize {
  const imageWidth = Number.isFinite(image.width) && image.width > 0 ? image.width : 1;
  const imageHeight = Number.isFinite(image.height) && image.height > 0 ? image.height : 1;
  const viewportWidth = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : imageWidth;
  const viewportHeight = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : imageHeight;
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  return { width: imageWidth * scale, height: imageHeight * scale };
}

export function clampPreviewZoom(zoom: number): number {
  const value = Number.isFinite(zoom) ? zoom : MIN_PREVIEW_ZOOM;
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value));
}

/** Keep the content point under the pointer fixed while changing scale. */
export function zoomAroundPoint(pointer: PreviewPoint, currentZoom: number, nextZoom: number, offset: PreviewPoint, viewport?: PreviewSize): PreviewPoint {
  const from = clampPreviewZoom(currentZoom);
  const to = clampPreviewZoom(nextZoom);
  const center = viewport ? { x: viewport.width / 2, y: viewport.height / 2 } : { x: 0, y: 0 };
  const contentPointX = (pointer.x - center.x - offset.x) / from;
  const contentPointY = (pointer.y - center.y - offset.y) / from;
  return {
    x: pointer.x - center.x - contentPointX * to,
    y: pointer.y - center.y - contentPointY * to,
  };
}

/** Keep a scaled image from leaving its preview viewport. */
export function clampPreviewOffset(offset: PreviewPoint, viewport: PreviewSize, content: PreviewSize, zoom: number): PreviewPoint {
  const scale = clampPreviewZoom(zoom);
  const scaledWidth = content.width * scale;
  const scaledHeight = content.height * scale;
  const limitX = Math.max(0, (scaledWidth - viewport.width) / 2);
  const limitY = Math.max(0, (scaledHeight - viewport.height) / 2);
  return {
    x: Math.min(limitX, Math.max(-limitX, Number.isFinite(offset.x) ? offset.x : 0)),
    y: Math.min(limitY, Math.max(-limitY, Number.isFinite(offset.y) ? offset.y : 0)),
  };
}
