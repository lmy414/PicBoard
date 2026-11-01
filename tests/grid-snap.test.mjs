import assert from "node:assert/strict";
import test from "node:test";

const snap = await import("../shared/grid-snap.ts");

test("coordinates round to the nearest grid line, including negative values", () => {
  assert.equal(snap.snapCoordinate(0, 24), 0);
  assert.equal(snap.snapCoordinate(11, 24), 0);
  assert.equal(snap.snapCoordinate(13, 24), 24);
  assert.equal(snap.snapCoordinate(-11, 24), 0);
  assert.equal(snap.snapCoordinate(-13, 24), -24);
  assert.equal(snap.snapCoordinate(-25, 24), -24);
  assert.equal(snap.snapCoordinate(-37, 24), -48);
  assert.equal(snap.snapCoordinate(25, 16), 32);
  assert.equal(snap.snapCoordinate(47, 32), 32);
  assert.equal(snap.snapCoordinate(48, 32), 64);
  // -0 must normalize to a plain zero.
  assert.equal(Object.is(snap.snapCoordinate(-0.4, 24), 0), true);
});

test("points and group deltas snap both axes and preserve the set origin", () => {
  assert.deepEqual(snap.snapPoint({ x: 13, y: -13 }, 24), { x: 24, y: -24 });
  // A set whose bounding top-left starts off-grid jumps to the nearest line.
  assert.deepEqual(snap.snappedDelta({ x: 100, y: 100 }, { x: 5, y: 5 }, 24, true), { x: -4, y: -4 });
  assert.deepEqual(snap.snappedDelta({ x: 96, y: 72 }, { x: 1, y: -1 }, 24, true), { x: 0, y: 0 });
  // Free mode passes the raw delta through untouched.
  assert.deepEqual(snap.snappedDelta({ x: 100, y: 100 }, { x: 5, y: 5 }, 24, false), { x: 5, y: 5 });
});

test("Alt inverts the configured snap mode for one gesture", () => {
  assert.equal(snap.isSnapActive(true, false), true);
  assert.equal(snap.isSnapActive(true, true), false);
  assert.equal(snap.isSnapActive(false, false), false);
  assert.equal(snap.isSnapActive(false, true), true);
});

test("invalid grid sizes fall back to 24 instead of producing NaN", () => {
  assert.equal(snap.snapCoordinate(25, 0), 24);
  assert.equal(snap.snapCoordinate(25, Number.NaN), 24);
  assert.deepEqual(snap.snapPoint({ x: 25, y: 25 }, 0), { x: 24, y: 24 });
});
