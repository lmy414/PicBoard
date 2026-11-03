import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("settings page keeps the tray-era surface connected", async () => {
  const app = await read("renderer/src/App.tsx");
  const settingsPage = await read("renderer/src/ui/SettingsPage.tsx");
  const shell = await read("renderer/src/ui/ShellSettings.tsx");
  const settings = await read("renderer/src/ball-settings.ts");

  assert.match(app, /viewMode === "settings"/);
  assert.match(settingsPage, /<PluginsSection/);
  assert.match(settingsPage, /后台记录剪贴板/);
  assert.match(settingsPage, /历史保留时间/);
  assert.match(settingsPage, /已放到画布上或已分类的内容不会被自动清理/);
  assert.match(settingsPage, /分类管理/);
  assert.match(settingsPage, /文件路径/);
  assert.match(shell, /收纳到托盘/);
  assert.match(shell, /退出程序/);
  assert.doesNotMatch(shell, /悬浮球|"float"/);
  assert.doesNotMatch(app, /收起为悬浮球|悬浮球|CollapsedBall|BloubBall/);
  assert.doesNotMatch(app, /drag-in|importImages|importText|ACCEPTED_EXTENSIONS/);
  assert.match(app, /onNavigate/);
  assert.match(app, /revision/);
  assert.match(app, /document\.addEventListener\("dragover", block\)/);
  assert.match(app, /AppLogo/);
  assert.match(settings, /quick-image-board\.ball-settings/);
  await access(path.join(root, "renderer/src/third-party/bloub/LICENSE"));
});

test("canvas shell keeps explicit keyboard and paste guards", async () => {
  const app = await read("renderer/src/App.tsx");
  const stage = await read("renderer/src/canvas/CanvasStage.tsx");
  const css = await read("renderer/src/styles.css");

  // Inputs and rich editors keep native paste and editing keys.
  assert.match(app, /\[contenteditable\]:not\(\[contenteditable="false"\]\), \.ProseMirror/);
  assert.match(app, /if \(isEditableTarget\(event\.target\)\) return/);
  // A mounted full page owns Escape and its editing shortcuts.
  assert.match(app, /pageRef\.current\) return/);
  assert.match(app, /dialogRef\.current \|\| actionsRef\.current/);
  // Delete and copy operate on the current selection with the documented wording.
  assert.match(app, /selectedNodeIdsRef\.current\.length > 0 \|\| selectedEdgeIdsRef\.current\.length > 0/);
  assert.match(app, /已从画布移除，内容仍在剪贴板历史/);
  assert.match(app, /剪贴板中没有可收纳的内容/);
  const tree = await read("renderer/src/ui/CanvasTree.tsx");
  assert.match(tree, /text\/x-picboard-canvas/);
  assert.doesNotMatch(app, /onDragEnter|handleDragEnter|ACCEPTED_EXTENSIONS/);
  assert.match(app, /document\.addEventListener\("dragover", block\)/);

  // Gestures write the DOM directly and never leak pointer capture.
  assert.match(stage, /requestAnimationFrame/);
  assert.match(stage, /setPointerCapture/);
  assert.match(stage, /releasePointerCapture/);
  assert.match(stage, /edgeLayerRef\.current\?\.updateDrag/);
  assert.match(stage, /classList\.add\("connect-target"\)/);
  assert.match(stage, /className=\{`canvas-viewport/);

  assert.match(css, /\.canvas-node\.selected/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.edge-layer/);
  assert.match(css, /\.history-slot\.open/);
  assert.match(css, /\.history-slot\.overlay/);
  assert.doesNotMatch(css, /bloub|intake-badge|collapsed-shell/);
});

test("canvas nodes keep right-click actions without a more button", async () => {
  const node = await read("renderer/src/canvas/CanvasNodeView.tsx");
  assert.doesNotMatch(node, /className="card-more"/);
  assert.match(node, /onContextMenu=/);
  assert.match(node, /role="button"/);
  assert.match(node, /tabIndex=\{0\}/);
  assert.match(node, /onDoubleClick=/);
  assert.match(node, /node-handle/);
});

test("history drag placement converts through the live canvas transform", async () => {
  const app = await read("renderer/src/App.tsx");
  const stage = await read("renderer/src/canvas/CanvasStage.tsx");
  assert.match(app, /<HistoryDrawer/);
  assert.match(app, /onDropToCanvas=\{dropHistoryContent\}/);
  assert.match(app, /stage\.containsClient\(clientX, clientY\)/);
  assert.match(app, /stage\.worldPoint\(clientX, clientY\)/);
  assert.match(stage, /importViewport\(\)/);
});
