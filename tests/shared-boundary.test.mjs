import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
    "shared/minimap-geometry.ts",
    "shared/canvas-selection.ts",
    "shared/edge-geometry.ts",
    "shared/grid-snap.ts",
  ];

  for (const relativePath of files) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\(|require\s*\()[^\n;]*["'](?:node:|@tauri-apps\/|react)/);
    assert.doesNotMatch(source, /\b(?:window|document|navigator)\s*\./);
  }
});

test("renderer source depends on neutral modules and the Tauri platform adapter", async () => {
  const files = await sourceFilesUnder(path.join(root, "renderer"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\(|require\s*\()[^\n;]*["'][^"']*electron(?:[\\/"'])/i);
  }

  const app = await readFile(path.join(root, "renderer/src/App.tsx"), "utf8");
  const stage = await readFile(path.join(root, "renderer/src/canvas/CanvasStage.tsx"), "utf8");
  const miniMap = await readFile(path.join(root, "renderer/src/canvas/MiniMap.tsx"), "utf8");
  const edges = await readFile(path.join(root, "renderer/src/canvas/EdgeLayer.tsx"), "utf8");
  const bootstrap = await readFile(path.join(root, "renderer/src/platform/bootstrap.ts"), "utf8");
  assert.match(app, /from "\.\.\/\.\.\/shared\/image-board"/);
  assert.match(miniMap, /from "\.\.\/\.\.\/\.\.\/shared\/minimap-geometry"/);
  assert.match(stage, /from "\.\.\/\.\.\/\.\.\/shared\/canvas-selection"/);
  assert.match(stage, /from "\.\.\/\.\.\/\.\.\/shared\/edge-geometry"/);
  assert.match(edges, /from "\.\.\/\.\.\/\.\.\/shared\/edge-geometry"/);
  assert.match(bootstrap, /isTauri\(\)/);
  assert.match(bootstrap, /createTauriAdapter\(\)/);
  assert.doesNotMatch(bootstrap, /Electron|electron/);
});
