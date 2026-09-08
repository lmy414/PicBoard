import assert from "node:assert/strict";
import test from "node:test";

const look = await import("../shared/look-geometry.ts");
const miniMap = await import("../shared/minimap-geometry.ts");

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
