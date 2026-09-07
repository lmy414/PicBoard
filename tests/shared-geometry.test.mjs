import assert from "node:assert/strict";
import test from "node:test";

const neutralLook = await import("../dist-electron/shared/look-geometry.js");
const legacyLook = await import("../dist-electron/electron/main/look-geometry.js");
const neutralMiniMap = await import("../dist-electron/shared/minimap-geometry.js");
const legacyMiniMap = await import("../dist-electron/electron/main/minimap-geometry.js");

function assertSameLook(input, expected) {
  assert.deepEqual(neutralLook.pointerToLookTarget(...input), expected);
  assert.deepEqual(legacyLook.pointerToLookTarget(...input), expected);
  assert.deepEqual(neutralLook.pointerToLookTarget(...input), legacyLook.pointerToLookTarget(...input));
}

test("pointer look mapping keeps fixed bounded outputs for normal, extreme, and invalid input", () => {
  assertSameLook([0, 0], { yaw: 0, pitch: -0 });
  assertSameLook([0.5, -0.25, 20, 10], { yaw: 10, pitch: 2.5 });
  assertSameLook([3, 4, 10, 5], { yaw: 6, pitch: -4 });
  assertSameLook([Number.NaN, Number.POSITIVE_INFINITY], { yaw: 0, pitch: -0 });
  assertSameLook([1, 0, Number.NaN, -1], { yaw: 28, pitch: -0 });
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

  const neutral = neutralMiniMap.createMiniMapGeometry(images, viewport, 60, 60);
  const legacy = legacyMiniMap.createMiniMapGeometry(images, viewport, 60, 60);
  assert.deepEqual(neutral, expected);
  assert.deepEqual(legacy, expected);
  assert.deepEqual(neutral, legacy);
  assert.deepEqual(neutralMiniMap.miniMapToWorld(neutral, 30, 30), { x: 0, y: 0 });
  assert.deepEqual(legacyMiniMap.miniMapToWorld(legacy, 30, 30), { x: 0, y: 0 });
});
