import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("settings page and bloub renderer remain connected", async () => {
  const app = await readFile(path.join(root, "renderer/src/App.tsx"), "utf8");
  const ball = await readFile(path.join(root, "renderer/src/BloubBall.tsx"), "utf8");
  const settings = await readFile(path.join(root, "renderer/src/ball-settings.ts"), "utf8");

  assert.match(app, /viewMode === "settings"/);
  assert.match(app, /文件路径/);
  assert.match(app, /分类类别/);
  assert.match(app, /画布临时路径/);
  assert.match(ball, /new BotEngine/);
  assert.match(ball, /<mask/);
  assert.match(ball, /window\.addEventListener\("pointermove"/);
  assert.match(ball, /onCursorPosition/);
  assert.match(ball, /bloub-hovered/);
  assert.match(ball, /onPointerEnter/);
  assert.match(app, /setPointerCapture/);
  assert.match(app, /onLostPointerCapture/);
  assert.match(app, /dragStartedRef\.current\) finish\(false\)/);
  assert.match(app, /activePointerRef\.current === event\.pointerId && !dragStartedRef\.current/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /copyImageFiles/);
  assert.match(app, /正在复制图片文件/);
  assert.match(app, /setBusy\(true\)/);
  assert.match(app, /loadError/);
  assert.match(ball, /pointerToLookTarget/);
  assert.match(ball, /setLook\(settings\.followGaze \? [\s\S]*: null/);
  assert.match(ball, /engine\.setLook/);
  assert.match(ball, /REST_STATES/);
  assert.match(ball, /SPARK_STATES/);
  assert.match(settings, /quick-image-board\.ball-settings/);
  await access(path.join(root, "renderer/src/third-party/bloub/LICENSE"));
});

test("canvas authorization iteration keeps image intent and keyboard guards explicit", async () => {
  const app = await readFile(path.join(root, "renderer/src/App.tsx"), "utf8");
  const css = await readFile(path.join(root, "renderer/src/styles.css"), "utf8");
  const ball = await readFile(path.join(root, "renderer/src/BloubBall.tsx"), "utf8");

  assert.match(app, /const \[hoveredId, setHoveredId\]/);
  assert.match(app, /previewId[^\n]*selectedIds[^\n]*hoveredId/);
  assert.match(app, /!panelVisible \|\| busy/);
  assert.match(app, /contenteditable=true/);
  assert.match(app, /onDoubleClick/);
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /onLostPointerCapture/);
  assert.match(app, /dragDepthRef/);
  assert.match(app, /onDragEnter/);
  assert.match(app, /dropActive/);
  assert.match(app, /library-card[^\n]*onDoubleClick/);
  assert.match(app, /showRemove=\{false\}/);
  assert.match(app, /setSelectedIds\(\[\]\)/);
  assert.match(css, /\.quick-actions\.anchored/);
  assert.match(css, /bloub-drop-success/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(ball, /dragOpen/);
  assert.match(ball, /bloub-drag-open/);
});
