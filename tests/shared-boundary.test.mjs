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
    "shared/look-geometry.ts",
    "shared/minimap-geometry.ts",
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
  const ball = await readFile(path.join(root, "renderer/src/BloubBall.tsx"), "utf8");
  const bootstrap = await readFile(path.join(root, "renderer/src/platform/bootstrap.ts"), "utf8");
  assert.match(app, /from "\.\.\/\.\.\/shared\/image-board"/);
  assert.match(app, /from "\.\.\/\.\.\/shared\/minimap-geometry"/);
  assert.match(ball, /from "\.\.\/\.\.\/shared\/look-geometry"/);
  assert.match(bootstrap, /isTauri\(\)/);
  assert.match(bootstrap, /createTauriAdapter\(\)/);
  assert.doesNotMatch(bootstrap, /Electron|electron/);
});
