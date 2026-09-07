import assert from "node:assert/strict";
import test from "node:test";

const {
  createWindowGeometryState,
  fitWindowToWorkArea,
  transitionWindowExpansion,
} = await import("../dist-electron/electron/main/window-geometry.js");

test("expanding remembers the collapsed ball bounds and repeated expansion is idempotent", () => {
  const originalBounds = { x: 1180, y: 36, width: 88, height: 88 };
  const originalWorkArea = { x: 0, y: 0, width: 1366, height: 768 };
  const otherWorkArea = { x: 1366, y: 0, width: 1920, height: 1080 };
  let state = createWindowGeometryState();

  const expanded = transitionWindowExpansion(originalBounds, originalWorkArea, true, state);
  state = expanded.state;
  assert.equal(expanded.changed, true);
  assert.deepEqual(expanded.state.collapsedBounds, originalBounds);
  assert.deepEqual(expanded.state.collapsedWorkArea, originalWorkArea);
  assert.deepEqual(expanded.bounds, fitWindowToWorkArea(originalBounds, originalWorkArea, true));

  const repeated = transitionWindowExpansion(expanded.bounds, otherWorkArea, true, state);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.bounds, expanded.bounds);
  assert.deepEqual(repeated.state, state);
});

test("collapsing restores the pre-expansion ball position and fits it to the current display", () => {
  const originalBounds = { x: -40, y: 700, width: 88, height: 88 };
  const originalWorkArea = { x: -100, y: 0, width: 1366, height: 768 };
  const currentWorkArea = { x: 0, y: 0, width: 2560, height: 1440 };
  const expandedBounds = { x: 20, y: 10, width: 660, height: 744 };
  let state = createWindowGeometryState();
  state = transitionWindowExpansion(originalBounds, originalWorkArea, true, state).state;

  const collapsed = transitionWindowExpansion(expandedBounds, currentWorkArea, false, state);
  assert.equal(collapsed.changed, true);
  assert.deepEqual(collapsed.bounds, fitWindowToWorkArea(originalBounds, currentWorkArea, false));
  assert.equal(collapsed.state.expanded, false);
  assert.equal(collapsed.state.collapsedBounds, null);
  assert.equal(collapsed.state.collapsedWorkArea, null);
});

test("collapsing after the original display changes fits remembered bounds to the current work area", () => {
  const originalBounds = { x: 1180, y: 680, width: 88, height: 88 };
  const originalWorkArea = { x: 0, y: 0, width: 1366, height: 768 };
  const currentWorkArea = { x: 0, y: 0, width: 1024, height: 640 };
  let state = createWindowGeometryState();
  state = transitionWindowExpansion(originalBounds, originalWorkArea, true, state).state;

  const collapsed = transitionWindowExpansion(
    { x: 220, y: 10, width: 660, height: 616 },
    currentWorkArea,
    false,
    state,
  );

  assert.deepEqual(collapsed.bounds, fitWindowToWorkArea(originalBounds, currentWorkArea, false));
});

test("unchanged expansion state does not request another bounds update", () => {
  const bounds = { x: 100, y: 100, width: 88, height: 88 };
  const workArea = { x: 0, y: 0, width: 1280, height: 720 };
  const state = createWindowGeometryState();

  const collapsed = transitionWindowExpansion(bounds, workArea, false, state);
  assert.equal(collapsed.changed, false);
  assert.deepEqual(collapsed.bounds, bounds);
  assert.deepEqual(collapsed.state, state);
});
