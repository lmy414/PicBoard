import assert from "node:assert/strict";
import test from "node:test";

const miniMap = await import("../shared/minimap-geometry.ts");
const selection = await import("../shared/canvas-selection.ts");

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
  const items = [
    { id: "a", x: 0, y: 0, width: 20, height: 20 },
    { id: "b", x: 25, y: 10, width: 20, height: 20 },
    { id: "c", x: 100, y: 100, width: 20, height: 20 },
  ];
  assert.deepEqual(selection.itemsInSelectionRect(items, { x: 10, y: 5, width: 40, height: 30 }), ["a", "b"]);
  assert.deepEqual(selection.mergeSelection(["c"], ["a", "c"], true), ["c", "a"]);
});

