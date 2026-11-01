import assert from "node:assert/strict";
import test from "node:test";

const bp = await import("../renderer/src/ui/breakpoints.ts");

test("the sidebar docks on wide windows and rides the rail below the threshold", () => {
  assert.equal(bp.sidebarLayout(1280), "docked");
  assert.equal(bp.sidebarLayout(1100), "docked");
  assert.equal(bp.sidebarLayout(1099), "overlay");
  assert.equal(bp.sidebarLayout(720), "overlay");
  assert.equal(bp.sidebarLayout(Number.NaN), "docked");
});

test("the drawer docks while the canvas keeps 480 px beside it", () => {
  assert.equal(bp.drawerLayout(780), "docked");
  assert.equal(bp.drawerLayout(1280), "docked");
  assert.equal(bp.drawerLayout(779), "overlay");
  assert.equal(bp.drawerLayout(480), "overlay");
  assert.equal(bp.drawerLayout(0), "overlay");
  assert.equal(bp.drawerLayout(Number.NaN), "docked");
});

test("the minimap bucket tracks the 560 px canvas threshold", () => {
  assert.equal(bp.minimapBucket(560), "wide");
  assert.equal(bp.minimapBucket(559), "narrow");
  assert.equal(bp.minimapBucket(2560), "wide");
  assert.equal(bp.minimapBucket(Number.NaN), "wide");
});

test("the topbar collapses its secondary buttons below 900 px", () => {
  assert.equal(bp.topbarLayout(901), "full");
  assert.equal(bp.topbarLayout(900), "compact");
  assert.equal(bp.topbarLayout(720), "compact");
  assert.equal(bp.topbarLayout(2560), "full");
  assert.equal(bp.topbarLayout(Number.NaN), "full");
});
