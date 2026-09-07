export interface MiniMapImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MiniMapViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
}

export interface MiniMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MiniMapGeometry {
  width: number;
  height: number;
  originX: number;
  originY: number;
  scale: number;
  images: Array<MiniMapRect & { id: string }>;
  viewport: MiniMapRect;
}

/** Maps negative/positive infinite-canvas coordinates into a stable small map. */
export function createMiniMapGeometry(images: MiniMapImage[], viewport: MiniMapViewport, width = 164, height = 104): MiniMapGeometry {
  const visibleWidth = Math.max(1, viewport.width / Math.max(0.01, viewport.zoom));
  const visibleHeight = Math.max(1, viewport.height / Math.max(0.01, viewport.zoom));
  const visibleRight = -viewport.x / Math.max(0.01, viewport.zoom) + visibleWidth;
  const visibleBottom = -viewport.y / Math.max(0.01, viewport.zoom) + visibleHeight;
  const imageRight = images.length ? Math.max(...images.map((image) => image.x + image.width)) : 0;
  const imageBottom = images.length ? Math.max(...images.map((image) => image.y + image.height)) : 0;
  const imageLeft = images.length ? Math.min(...images.map((image) => image.x)) : 0;
  const imageTop = images.length ? Math.min(...images.map((image) => image.y)) : 0;
  const minX = Math.min(imageLeft, -viewport.x / Math.max(0.01, viewport.zoom), 0);
  const minY = Math.min(imageTop, -viewport.y / Math.max(0.01, viewport.zoom), 0);
  const maxX = Math.max(imageRight, visibleRight, 0);
  const maxY = Math.max(imageBottom, visibleBottom, 0);
  const padding = Math.max(40, Math.max(maxX - minX, maxY - minY) * 0.08);
  const worldWidth = Math.max(1, maxX - minX + padding * 2);
  const worldHeight = Math.max(1, maxY - minY + padding * 2);
  const scale = Math.min((width - 12) / worldWidth, (height - 12) / worldHeight);
  const originX = minX - padding;
  const originY = minY - padding;
  const project = (x: number, y: number, itemWidth: number, itemHeight: number): MiniMapRect => ({
    x: 6 + (x - originX) * scale,
    y: 6 + (y - originY) * scale,
    width: Math.max(2, itemWidth * scale),
    height: Math.max(2, itemHeight * scale),
  });
  return {
    width,
    height,
    originX,
    originY,
    scale,
    images: images.map((image) => ({ ...project(image.x, image.y, image.width, image.height), id: image.id })),
    viewport: project(-viewport.x / Math.max(0.01, viewport.zoom), -viewport.y / Math.max(0.01, viewport.zoom), visibleWidth, visibleHeight),
  };
}

export function miniMapToWorld(geometry: MiniMapGeometry, x: number, y: number) {
  return { x: geometry.originX + (x - 6) / geometry.scale, y: geometry.originY + (y - 6) / geometry.scale };
}
