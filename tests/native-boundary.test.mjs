import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

function branchBetween(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing branch start: ${start}`);
  assert.notEqual(to, -1, `missing branch end: ${end}`);
  return text.slice(from, to);
}

function assertOrdered(text, labels) {
  let cursor = -1;
  for (const label of labels) {
    const next = text.indexOf(label);
    assert.ok(next > cursor, `${label} must appear after the previous operation`);
    cursor = next;
  }
}

test("only the Rust/Tauri desktop route remains executable", async () => {
  const pkg = JSON.parse(await source("package.json"));
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.dependencies?.electron, undefined);
  assert.equal(pkg.devDependencies?.electron, undefined);
  for (const name of ["dev:electron", "build:electron", "export:prefs"]) {
    assert.equal(pkg.scripts?.[name], undefined);
  }
  assert.match(pkg.scripts.dev, /dev-rust\.mjs/);
  assert.match(pkg.scripts["dev:rust"], /dev-rust\.mjs/);

  for (const removed of [
    "electron/main/index.ts",
    "electron/preload/index.ts",
    "electron/main/storage.ts",
    "electron/main/windows-clipboard.ts",
    "tsconfig.node.json",
  ]) {
    await assert.rejects(access(path.join(root, removed)), { code: "ENOENT" });
  }
});

test("native lifecycle keeps UI teardown non-blocking and close operations ordered", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const destroyed = branchBetween(lib, "WindowEvent::Destroyed", "// Intercept close requests");
  assert.match(destroyed, /request_teardown\(\)/);
  assert.doesNotMatch(destroyed, /\.join\(|cancel_drag\(\)|stop_cursor_tracking\(\)/);

  const host = await source("src-tauri/src/desktop/host.rs");
  const floatBranch = branchBetween(host, "CloseBehavior::Float =>", "CloseBehavior::Tray =>");
  assertOrdered(floatBranch, [".cancel_drag()", "set_window_expanded_state(app, false)", "window.show()"]);
  assert.doesNotMatch(floatBranch, /stop_cursor_tracking/);

  const trayBranch = branchBetween(host, "CloseBehavior::Tray =>", "\n        }");
  assertOrdered(trayBranch, ["mark_user_hidden()", ".cancel_drag()", ".stop_cursor_tracking()", "set_window_expanded_state(app, false)", "window.hide()"]);
});

test("every tray show path restores cursor tracking", async () => {
  const tray = await source("src-tauri/src/desktop/tray.rs");
  const menuPath = branchBetween(tray, "builder = builder.on_menu_event", "let open_app2");
  const clickPath = branchBetween(tray, "builder = builder.on_tray_icon_event", "builder.build(app)?");
  for (const showPath of [menuPath, clickPath]) {
    assertOrdered(showPath, ["mark_user_shown()", "window.show()?", "start_cursor_tracking()"]);
  }
});

test("drag end is idempotent, generation-scoped, and never joins on the interaction path", async () => {
  const controller = await source("src-tauri/src/window_controller.rs");
  const start = branchBetween(controller, "pub fn start_window_drag", "/// End the custom drag");
  const end = branchBetween(controller, "pub fn end_window_drag", "/// Start the 50ms cursor publisher");
  assert.match(start, /drag_generation\.fetch_add\(1/);
  assert.match(start, /drag_generation\.load\(Ordering::Acquire\) == generation/);
  assert.match(end, /drag_generation\.fetch_add\(1/);
  assert.match(end, /let was_active = self\.inner\.drag_active\.swap\(false/);
  assert.match(end, /if !was_active/);
  assert.match(end, /reap_thread\(thread\)/);
  assert.doesNotMatch(end, /thread\.join\(\)/);
  assertOrdered(end, ["drag_generation.fetch_add(1", "drag_active.swap(false", "reap_thread(thread)", "if !was_active", "self.start_cursor_tracking()"]);
});

test("cursor stop does not join a worker waiting for window messages", async () => {
  const controller = await source("src-tauri/src/window_controller.rs");
  const stop = branchBetween(controller, "pub fn stop_cursor_tracking", "/// Stop the drag loop");
  assert.match(stop, /cursor_generation\.fetch_add\(1/);
  assert.match(stop, /reap_thread\(thread\)/);
  assert.doesNotMatch(stop, /thread\.join\(\)/);
  const spawn = controller.slice(controller.indexOf("fn spawn_cursor_thread"));
  assert.match(spawn, /cursor_generation\.load\(Ordering::Acquire\) == generation/);
});

test("renderer hydrates native expansion state before the first frame after reload", async () => {
  const contract = await source("shared/image-board.ts");
  assert.match(contract, /getExpanded\(\): Promise<boolean>/);

  const adapter = await source("renderer/src/platform/tauri-adapter.ts");
  assert.match(adapter, /getExpanded: \(\) => call<boolean>\("getExpanded"\)/);

  const commands = await source("src-tauri/src/commands.rs");
  assert.match(commands, /pub fn get_expanded[\s\S]*window\.is_expanded\(\)/);

  const main = await source("renderer/src/main.tsx");
  const start = branchBetween(main, "async function start()", "\nvoid start();");
  const hydration = branchBetween(start, "const initialExpanded", "requestAnimationFrame(");
  assert.ok(start.indexOf("bootstrapImageBoard()") < start.indexOf("const initialExpanded"));
  assertOrdered(hydration, [".getExpanded()", ".setExpanded(initialExpanded)", "root.render("]);
  assert.match(hydration, /<App initialExpanded=\{initialExpanded\}/);

  const app = await source("renderer/src/App.tsx");
  assert.match(app, /function App\(\{ initialExpanded \}: \{ initialExpanded: boolean \}\)/);
  assert.match(app, /useState<PanelPhase>\(initialExpanded \? "expanded" : "collapsed"\)/);
  assert.match(app, /useRef<PanelPhase>\(initialExpanded \? "expanded" : "collapsed"\)/);
  assert.match(app, /useRef\(initialExpanded\)/);
});

test("maximize preserves restore bounds and collapse restores first", async () => {
  const controller = await source("src-tauri/src/window_controller.rs");
  const toggle = branchBetween(controller, "pub fn toggle_maximized", "/// Begin the custom drag");
  assert.ok(toggle.includes("*restore = Some(current)"));
  assert.ok(toggle.includes("set_logical_bounds(&win, work)?"));
  assert.ok(toggle.includes("set_logical_bounds(&win, bounds)?"));
  const expansion = controller.slice(controller.indexOf("fn apply_expansion("));
  assert.ok(expansion.indexOf("controller.toggle_maximized()?") < expansion.indexOf("transition_window_expansion"));
});
