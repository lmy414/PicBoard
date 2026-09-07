import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const source = await readFile(path.resolve(import.meta.dirname, "../electron/main/index.ts"), "utf8");

test("window collapse rematches the remembered ball bounds against the current display", () => {
  assert.match(source, /!isExpanded && windowGeometryState\.collapsedBounds/);
  assert.match(source, /screen\.getDisplayMatching\(windowGeometryState\.collapsedBounds\)/);
  assert.match(source, /transitionWindowExpansion\(current, display\.workArea, isExpanded, windowGeometryState\)/);
});

test("window dragging polls at 8ms and skips unchanged positions", () => {
  assert.match(source, /setInterval\(moveWindowFromCursor, 8\)/);
  assert.match(source, /if \(!windowDragLastPosition \|\| fitted\.x !== windowDragLastPosition\.x \|\| fitted\.y !== windowDragLastPosition\.y\)/);
});

test("window drag release flushes the final cursor position", () => {
  const stopBody = source.match(/function stopWindowDrag\(\)[\s\S]*?\n}\n\nfunction moveWindowFromCursor/)?.[0] ?? "";
  assert.match(stopBody, /moveWindowFromCursor\(\)/);
});

test("cursor position IPC is paused during native window dragging", () => {
  const startBody = source.match(/function startWindowDrag\(\)[\s\S]*?\n}\n\nfunction createWindow/)?.[0] ?? "";
  const stopBody = source.match(/function stopWindowDrag\(\)[\s\S]*?\n}\n\nfunction moveWindowFromCursor/)?.[0] ?? "";
  assert.match(startBody, /stopCursorTracking\(\)/);
  assert.match(stopBody, /startCursorTracking\(\)/);
});
