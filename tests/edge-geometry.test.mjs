import assert from "node:assert/strict";
import test from "node:test";

const geometry = await import("../shared/edge-geometry.ts");

const viewport = { x: 0, y: 0, zoom: 1 };
const node = (id, x, y, width = 100, height = 60) => ({ id, contentId: `content-${id}`, x, y, width, height });

function state(edges = []) {
  return {
    activeCanvasId: "root",
    canvases: [
      { id: "root", name: "根画布", parentId: null, frame: null, nodes: [node("a", 0, 0), node("b", 300, 10)], createdAt: "", viewport },
      { id: "child", name: "子画布", parentId: "root", frame: { x: 500, y: 0, width: 300, height: 200 }, nodes: [node("c", 20, 20)], createdAt: "", viewport },
      { id: "grand", name: "孙画布", parentId: "child", frame: { x: 100, y: 60, width: 120, height: 80 }, nodes: [node("d", 10, 10)], createdAt: "", viewport },
      { id: "other", name: "另一个根画布", parentId: null, frame: null, nodes: [node("e", 0, 0)], createdAt: "", viewport },
    ],
    categories: [],
    contents: {},
    edges,
  };
}

const edge = (id, fromNode, toNode) => ({ id, fromNode, toNode, createdAt: "" });

test("a direct edge resolves to both node rects on the active canvas", () => {
  const resolved = geometry.resolveCanvasEdges(state([edge("direct", "a", "b")]), "root");
  assert.deepEqual(resolved, [{
    edgeId: "direct",
    from: { kind: "node", nodeId: "a", rect: { x: 0, y: 0, width: 100, height: 60 } },
    to: { kind: "node", nodeId: "b", rect: { x: 300, y: 10, width: 100, height: 60 } },
  }]);
  // A root-level node does not resolve from an unrelated canvas.
  assert.deepEqual(geometry.resolveCanvasEdges(state([edge("direct", "a", "b")]), "other"), []);
});

test("a nested end resolves to the direct child card, however deep it is", () => {
  const resolved = geometry.resolveCanvasEdges(state([edge("nested", "a", "d")]), "root");
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0].to, { kind: "card", canvasId: "child", rect: { x: 500, y: 0, width: 300, height: 200 } });

  // One level down, the grandchild node is still represented by the grandchild card.
  const inside = geometry.resolveCanvasEdges(state([edge("nested", "c", "d")]), "child");
  assert.deepEqual(inside[0].to, { kind: "card", canvasId: "grand", rect: { x: 100, y: 60, width: 120, height: 80 } });
});

test("edges whose two ends collapse into one card stay hidden there", () => {
  const resolved = geometry.resolveCanvasEdges(state([edge("internal", "c", "d")]), "root");
  assert.deepEqual(resolved, []);
});

test("edges touching a canvas outside the subtree or unknown nodes stay hidden", () => {
  const edges = [edge("outside", "a", "e"), edge("unknown", "a", "missing")];
  assert.deepEqual(geometry.resolveCanvasEdges(state(edges), "root"), []);
  assert.deepEqual(geometry.resolveCanvasEdges(state([edge("outside", "a", "e")]), "other"), []);
  // Unknown canvas ids produce no edges at all.
  assert.deepEqual(geometry.resolveCanvasEdges(state([edge("direct", "a", "b")]), "missing"), []);
});

test("side choice follows the dominant axis and the bezier control offset is clamped", () => {
  const horizontal = geometry.edgePath({ x: 0, y: 0, width: 100, height: 60 }, { x: 300, y: 10, width: 100, height: 60 });
  assert.deepEqual(horizontal.start, { x: 100, y: 30 });
  assert.deepEqual(horizontal.end, { x: 300, y: 40 });
  assert.equal(horizontal.endAngle, 0);
  assert.match(horizontal.d, /^M 100 30 C /);

  const vertical = geometry.edgePath({ x: 0, y: 0, width: 100, height: 60 }, { x: 40, y: 300, width: 100, height: 60 });
  assert.deepEqual(vertical.start, { x: 50, y: 60 });
  assert.deepEqual(vertical.end, { x: 90, y: 300 });
  assert.equal(vertical.endAngle, Math.PI / 2);
  assert.match(vertical.d, /^M 50 60 C /);

  // Backwards relations enter the opposite side of the target.
  const backwards = geometry.edgePath({ x: 300, y: 0, width: 100, height: 60 }, { x: 0, y: 0, width: 100, height: 60 });
  assert.deepEqual(backwards.start, { x: 300, y: 30 });
  assert.deepEqual(backwards.end, { x: 100, y: 30 });
  assert.equal(backwards.endAngle, Math.PI);

  const far = geometry.edgePath({ x: 0, y: 0, width: 100, height: 100 }, { x: 1000, y: 0, width: 100, height: 100 });
  assert.equal(far.d, "M 100 50 C 260 50, 840 50, 1000 50");
});
