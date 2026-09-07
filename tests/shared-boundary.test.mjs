import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function sourceFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFilesUnder(entryPath));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test("neutral shared modules do not import host or renderer runtime APIs", async () => {
  const files = [
    "shared/image-board.ts",
    "shared/look-geometry.ts",
    "shared/minimap-geometry.ts",
    "shared/window-geometry.ts",
  ];

  for (const relativePath of files) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\(|require\s*\()[^\n;]*["'](?:electron|node:|@tauri-apps\/|react)/);
    assert.doesNotMatch(source, /\b(?:window|document|navigator)\s*\./);
  }
});

test("renderer source depends on neutral modules instead of Electron source paths", async () => {
  const files = await sourceFilesUnder(path.join(root, "renderer"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*electron(?:[\\/"'])/);
    assert.doesNotMatch(source, /import\s*\(\s*["'][^"']*electron(?:[\\/"'])/);
  }

  const app = await readFile(path.join(root, "renderer/src/App.tsx"), "utf8");
  const ball = await readFile(path.join(root, "renderer/src/BloubBall.tsx"), "utf8");
  assert.match(app, /from "\.\.\/\.\.\/shared\/image-board"/);
  assert.match(app, /from "\.\.\/\.\.\/shared\/minimap-geometry"/);
  assert.match(ball, /from "\.\.\/\.\.\/shared\/look-geometry"/);
});

test("Electron compatibility paths still compile and expose the geometry API", async () => {
  const compatibilityFiles = [
    "dist-electron/electron/shared.js",
    "dist-electron/electron/main/look-geometry.js",
    "dist-electron/electron/main/minimap-geometry.js",
    "dist-electron/electron/main/window-geometry.js",
    "dist-electron/shared/image-board.js",
    "dist-electron/shared/look-geometry.js",
    "dist-electron/shared/minimap-geometry.js",
    "dist-electron/shared/window-geometry.js",
  ];
  await Promise.all(compatibilityFiles.map((relativePath) => access(path.join(root, relativePath))));

  const legacyLook = await import("../dist-electron/electron/main/look-geometry.js");
  const legacyMiniMap = await import("../dist-electron/electron/main/minimap-geometry.js");
  const legacyWindow = await import("../dist-electron/electron/main/window-geometry.js");
  assert.equal(typeof legacyLook.pointerToLookTarget, "function");
  assert.equal(legacyLook.MAX_LOOK_YAW, 28);
  assert.equal(legacyLook.MAX_LOOK_PITCH, 24);
  assert.equal(typeof legacyMiniMap.createMiniMapGeometry, "function");
  assert.equal(typeof legacyMiniMap.miniMapToWorld, "function");
  assert.equal(typeof legacyWindow.createWindowGeometryState, "function");
  assert.equal(typeof legacyWindow.fitWindowToWorkArea, "function");
  assert.equal(typeof legacyWindow.transitionWindowExpansion, "function");

  const electronShared = await readFile(path.join(root, "electron/shared.ts"), "utf8");
  const neutralContract = await readFile(path.join(root, "shared/image-board.ts"), "utf8");
  assert.match(electronShared, /^export \* from "\.\.\/shared\/image-board";$/m);
  assert.doesNotMatch(electronShared, /declare global/);
  assert.match(neutralContract, /declare global/);
});

test("Electron preload keeps the complete ImageBoard API surface", async () => {
  const preload = await readFile(path.join(root, "electron/preload/index.ts"), "utf8");
  const methods = [
    "loadState",
    "importImages",
    "pasteImage",
    "setActiveCanvas",
    "setCanvasViewport",
    "createCanvas",
    "renameCanvas",
    "deleteCanvas",
    "createCategory",
    "classifyImages",
    "removeImageFromCanvas",
    "moveImage",
    "copyImageFiles",
    "setExpanded",
    "closeWindow",
    "startWindowDrag",
    "endWindowDrag",
    "onCursorPosition",
  ];

  assert.match(preload, /contextBridge\.exposeInMainWorld\("imageBoard", api\)/);
  for (const method of methods) assert.match(preload, new RegExp(`\\b${method}\\s*:`));
});
