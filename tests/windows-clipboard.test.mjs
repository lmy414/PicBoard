import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "electron/main/windows-clipboard.ts");

// These tests deliberately inspect the generated helper instead of touching the
// user's real clipboard. End-to-end clipboard verification is kept manual on a
// Windows desktop because it necessarily changes global user state.
test("Windows clipboard helper publishes a persistent FileDrop DataObject", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /System\.Windows\.Forms/);
  assert.match(source, /data\.SetFileDropList\(files\)/);
  assert.match(source, /Clipboard\.SetDataObject\(data, true\)/);
  assert.match(source, /-STA/);
  assert.match(source, /paths\.Length == 1 && !String\.IsNullOrWhiteSpace\(imagePath\)/);
});

test("single WebP-capable image path decodes with Electron and passes a temporary PNG", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /import \{ nativeImage \} from "electron"/);
  assert.match(source, /if \(filePaths\.length === 1\)/);
  assert.match(source, /nativeImage\.createFromPath\(filePaths\[0\]\)/);
  assert.match(source, /image\.isEmpty\(\)/);
  assert.match(source, /temporaryDirectory = await fs\.mkdtemp\(path\.join\(os\.tmpdir\(\), "quick-image-board-clipboard-"\)\)/);
  assert.match(source, /imagePath = path\.join\(temporaryDirectory, "clipboard\.png"\)/);
  assert.match(source, /fs\.writeFile\(imagePath, image\.toPNG\(\), \{ flag: "wx" \}\)/);
  assert.match(source, /JSON\.stringify\(\{ filePaths, imagePath \}\)/);
  assert.match(source, /SetFiles\(\[string\[\]\]\$payload\.filePaths, \[string\]\$payload\.imagePath\)/);
});

test("single-image Bitmap keeps alpha and multi-image copy remains FileDrop-only", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /PixelFormat\.Format32bppArgb/);
  assert.match(source, /CompositingMode\.SourceCopy/);
  assert.match(source, /data\.SetData\(DataFormats\.Bitmap, true, bitmap\)/);
  assert.match(source, /Multiple images intentionally[\s\S]*?FileDrop-only/);
  assert.match(source, /data\.SetFileDropList\(files\)/);
});

test("temporary image directory is cleaned after helper success or failure", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /finally \{[\s\S]*?if \(temporaryDirectory\) await fs\.rm\(temporaryDirectory, \{ recursive: true, force: true \}\)/);
});

test("writer keeps the existing callable interface and rejects non-Windows use", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /export function createWindowsFileClipboardWriter\(\)/);
  assert.match(source, /return async \(filePaths: string\[\]\)/);
  assert.match(source, /process\.platform !== "win32"/);
});
