import assert from "node:assert/strict";
import test from "node:test";

const look = await import("../shared/look-geometry.ts");
const miniMap = await import("../shared/minimap-geometry.ts");
const selection = await import("../shared/canvas-selection.ts");
const preview = await import("../shared/preview-geometry.ts");

test("pointer look mapping keeps fixed bounded outputs for normal, extreme, and invalid input", () => {
  assert.deepEqual(look.pointerToLookTarget(0, 0), { yaw: 0, pitch: -0 });
  assert.deepEqual(look.pointerToLookTarget(0.5, -0.25, 20, 10), { yaw: 10, pitch: 2.5 });
  assert.deepEqual(look.pointerToLookTarget(3, 4, 10, 5), { yaw: 6, pitch: -4 });
  assert.deepEqual(look.pointerToLookTarget(Number.NaN, Number.POSITIVE_INFINITY), { yaw: 0, pitch: -0 });
  assert.deepEqual(look.pointerToLookTarget(1, 0, Number.NaN, -1), { yaw: 28, pitch: -0 });
});

test("mini-map projection preserves negative coordinates, zoom, image bounds, and inverse navigation", () => {
  const images = [{ id: "negative", x: -8, y: -8, width: 8, height: 8 }];
  const viewport = { x: 16, y: 16, width: 32, height: 32, zoom: 2 };
  const expected = {
    width: 60,
    height: 60,
    originX: -48,
    originY: -48,
    scale: 0.5,
    images: [{ id: "negative", x: 26, y: 26, width: 4, height: 4 }],
    viewport: { x: 26, y: 26, width: 8, height: 8 },
  };

  const geometry = miniMap.createMiniMapGeometry(images, viewport, 60, 60);
  assert.deepEqual(geometry, expected);
  assert.deepEqual(miniMap.miniMapToWorld(geometry, 30, 30), { x: 0, y: 0 });
});

test("canvas selection distinguishes replace, toggle, and rectangle selection", () => {
  assert.deepEqual(selection.applySelection([], "a", false), ["a"]);
  assert.deepEqual(selection.applySelection(["a", "b"], "b", true), ["a"]);
  assert.deepEqual(selection.applySelection(["a"], "b", true), ["a", "b"]);
  const images = [
    { id: "a", x: 0, y: 0, width: 20, height: 20 },
    { id: "b", x: 25, y: 10, width: 20, height: 20 },
    { id: "c", x: 100, y: 100, width: 20, height: 20 },
  ];
  assert.deepEqual(selection.imagesInSelectionRect(images, { x: 10, y: 5, width: 40, height: 30 }), ["a", "b"]);
  assert.deepEqual(selection.mergeSelection(["c"], ["a", "c"], true), ["c", "a"]);
});

test("preview geometry uses fit-size centered zoom and clamps pan offsets", () => {
  assert.equal(preview.clampPreviewZoom(0.2), 1);
  assert.equal(preview.clampPreviewZoom(9), 8);
  assert.deepEqual(preview.fitPreviewSize({ width: 1600, height: 800 }, { width: 400, height: 300 }), { width: 400, height: 200 });
  // QuickPreview centers the fitted image and applies `translate(offset) scale(zoom)`
  // around the viewport center. Translation is the outer transform here, so an
  // existing offset scales when preserving a pointer-centered image point.
  assert.deepEqual(preview.zoomAroundPoint({ x: 0, y: 150 }, 1, 2, { x: 0, y: 0 }, { width: 400, height: 300 }), { x: 200, y: 0 });
  assert.deepEqual(preview.zoomAroundPoint({ x: 200, y: 150 }, 1, 2, { x: 40, y: -20 }, { width: 400, height: 300 }), { x: 80, y: -40 });
  assert.deepEqual(preview.clampPreviewOffset({ x: 500, y: -500 }, { width: 200, height: 100 }, { width: 400, height: 300 }, 2), { x: 300, y: -250 });
});
