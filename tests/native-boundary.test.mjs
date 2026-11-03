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

test("window teardown stays non-blocking and close operations stay ordered", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const destroyed = branchBetween(lib, "WindowEvent::Destroyed", "// Intercept close requests");
  assert.match(destroyed, /request_teardown\(\)/);
  assert.doesNotMatch(destroyed, /\.join\(|stop_cursor_tracking\(\)|start_cursor_tracking\(\)/);

  const host = await source("src-tauri/src/desktop/host.rs");
  const trayBranch = host.slice(host.indexOf("CloseBehavior::Tray =>"));
  assert.match(trayBranch, /mark_user_hidden\("main"\)/);
  assert.match(trayBranch, /window\.hide\(\)\?/);
  assert.doesNotMatch(trayBranch, /cancel_drag|stop_cursor_tracking|set_window_expanded_state|app\.exit/);

  assert.match(host, /CloseBehavior::Quit => \{\s*app\.exit\(0\);/);
});

test("main is a plain desktop window and the tray panel is a flyout", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const mainBuilder = branchBetween(lib, 'WebviewWindowBuilder::new(app, "main"', ".build()?");
  assert.doesNotMatch(mainBuilder, /always_on_top\(true\)/);
  assert.doesNotMatch(mainBuilder, /skip_taskbar\(true\)/);
  assert.match(mainBuilder, /resizable\(true\)/);
  assert.match(mainBuilder, /disable_drag_drop_handler\(\)/);

  const trayUrl = branchBetween(lib, 'let tray_url =', 'WebviewWindowBuilder::new(app, "tray"');
  assert.match(trayUrl, /surface=tray/);
  const trayBuilder = branchBetween(lib, 'WebviewWindowBuilder::new(app, "tray"', ".build()?");
  assert.match(trayBuilder, /always_on_top\(true\)/);
  assert.match(trayBuilder, /skip_taskbar\(true\)/);
  assert.match(trayBuilder, /resizable\(false\)/);
  assert.match(trayBuilder, /visible\(false\)/);

  // Tray flyout hides on focus loss.
  const blur = branchBetween(lib, "tray_panel.on_window_event", "});");
  assert.match(blur, /Focused\(false\)/);
  assert.match(blur, /\.hide\(\)/);
});

test("ball drag, cursor tracking and drag-in commands are gone", async () => {
  const controller = await source("src-tauri/src/window_controller.rs");
  assert.doesNotMatch(controller, /start_window_drag|end_window_drag|spawn_cursor_thread|window:cursor-position|place_initial|apply_expansion|set_expanded/);

  const commands = await source("src-tauri/src/commands.rs");
  for (const gone of [
    "pub fn get_expanded",
    "pub fn set_expanded",
    "pub fn start_window_drag",
    "pub fn end_window_drag",
    "pub fn import_images",
    "pub fn import_text",
  ]) {
    assert.doesNotMatch(commands, new RegExp(gone.replace(/ /g, "\\s+")));
  }
  for (const present of [
    "pub fn show_main_window",
    "pub fn hide_tray_panel",
    "pub fn minimize_window",
    "pub fn quit_app",
    "pub fn paste_clipboard",
  ]) {
    assert.match(commands, new RegExp(present.replace(/ /g, "\\s+")));
  }
  // The cursor position event is gone, but a main:navigate broadcast exists.
  assert.doesNotMatch(controller, /window:cursor-position/);
  assert.match(controller, /main:navigate/);
});

test("mutating commands broadcast state-changed to all windows", async () => {
  const commands = await source("src-tauri/src/commands.rs");
  const broadcast = branchBetween(commands, "fn broadcast(", "let _ = app.emit(");
  assert.ok(broadcast.length > 0);
  const emitCount = (commands.match(/broadcast\(&app, /g) || []).length;
  assert.ok(emitCount >= 15, `expected at least 15 broadcasts, found ${emitCount}`);
  // Background capture and retention broadcast too (not window-scoped).
  const monitor = await source("src-tauri/src/clipboard/monitor.rs");
  assert.match(monitor, /app\.emit\(crate::STATE_CHANGED_EVENT/);
  const retention = await source("src-tauri/src/retention.rs");
  assert.match(retention, /app\.emit\(crate::STATE_CHANGED_EVENT/);
});

test("tray left click toggles the panel and the menu opens or quits", async () => {
  const tray = await source("src-tauri/src/desktop/tray.rs");
  const clickPath = branchBetween(tray, "on_tray_icon_event", "builder.build(app)?");
  assert.match(clickPath, /MouseButton::Left/);
  assert.match(clickPath, /toggle_tray_panel/);
  assert.match(tray, /show_menu_on_left_click\(false\)/);
  assert.match(tray, /打开 PicBoard/);
  assert.match(tray, /退出/);
  const menuPath = branchBetween(tray, "on_menu_event", "let toggle_app");
  assert.match(menuPath, /MENU_OPEN/);
  assert.match(menuPath, /show_main_window|show_main\(/);
  assert.match(menuPath, /exit\(0\)/);
});

test("auto-start launches silently into the tray", async () => {
  const autostart = await source("src-tauri/src/desktop/autostart.rs");
  assert.match(autostart, /--autostart/);
  const lib = await source("src-tauri/src/lib.rs");
  assert.match(lib, /--autostart/);
  assert.match(lib, /start_in_tray/);
  // The on-page-load reveal is skipped entirely on an auto-start launch.
  const pageLoad = branchBetween(lib, "on_page_load(move |_webview, payload|", ".build()?");
  assert.match(pageLoad, /page_start_in_tray/);
  assert.match(pageLoad, /if !page_start_in_tray \{/);
  const setupReveal = branchBetween(lib, "if !start_in_tray {", "// Clean up background loops");
  assert.match(setupReveal, /if !start_in_tray \{[\s\S]*?mark_placement_done\("main"\)/);
});

test("window gestures use one native maximize state and callbacks remain non-blocking", async () => {
  const controller = await source("src-tauri/src/window_controller.rs");
  const toggle = branchBetween(controller, "pub fn toggle_maximized", "pub fn start_titlebar_drag");
  // Windows owns the restore placement for both app buttons and OS shortcuts.
  assert.match(toggle, /win\.is_maximized\(\)/);
  assert.match(toggle, /win\.maximize\(\)/);
  assert.match(toggle, /win\.unmaximize\(\)/);
  assert.doesNotMatch(toggle, /set_logical_bounds|\.lock\(/);

  const drag = branchBetween(controller, "pub fn start_titlebar_drag", "pub fn start_resize_dragging");
  assert.match(drag, /win\.start_dragging\(\)/);
  assert.doesNotMatch(drag, /set_logical_bounds|\.lock\(/);
  const sizing = branchBetween(controller, "pub fn start_resize_dragging", "pub fn request_teardown");
  assert.match(sizing, /start_resize_dragging\(direction\)/);
  assert.match(sizing, /win\.is_maximized\(\)/);
  assert.match(sizing, /win\.is_minimized\(\)/);
  assert.doesNotMatch(sizing, /tray_panel/);

  const handler = branchBetween(controller, "pub fn note_window_geometry_changed", "pub fn is_maximized");
  assert.match(handler, /bounds_saver\.request\(\)/);
  assert.doesNotMatch(handler, /\.lock\(|win\.|is_maximized\(\)/);
});

test("window APIs are deferred out of window and tray callbacks", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const reveal = branchBetween(lib, "fn spawn_main_reveal", "fn setup_app");
  assert.match(reveal, /spawn_worker\("picboard-main-reveal"/);
  const blur = branchBetween(lib, "tray_panel.on_window_event", "});");
  assert.match(blur, /spawn_worker\("picboard-tray-blur"/);

  const tray = await source("src-tauri/src/desktop/tray.rs");
  const menu = branchBetween(tray, "on_menu_event", "let toggle_app");
  assert.match(menu, /spawn_worker\("picboard-tray-menu"/);
  const click = branchBetween(tray, "on_tray_icon_event", "builder.build(app)?");
  assert.match(click, /spawn_worker\("picboard-tray-click"/);

  const host = await source("src-tauri/src/desktop/host.rs");
  const close = branchBetween(host, "pub fn install_close_behavior", "/// Perform the close action");
  // Only the flag runs in the callback; hiding/exit is deferred.
  assert.match(close, /prevent_close\(\)/);
  assert.match(close, /spawn_worker\("picboard-close-action"/);
  assert.doesNotMatch(close, /\.hide\(\)|\.exit\(/);
});


test("launch images wait until both windows and close behavior exist", async () => {
  const lib = await source("src-tauri/src/lib.rs");
  const setup = branchBetween(lib, "fn setup_app", "pub fn run()");
  assert.doesNotMatch(setup, /image_files::open_path/);
  const ready = setup.indexOf("mark_setup_ready()");
  assert.ok(ready > setup.indexOf('WebviewWindowBuilder::new(app, "main"'));
  assert.ok(ready > setup.indexOf('WebviewWindowBuilder::new(app, "tray"'));
  assert.ok(ready > setup.indexOf("install_close_behavior(&window)?"));
  assert.ok(setup.indexOf("process_pending_images(app.handle())") > ready);
  const run = lib.slice(lib.indexOf("pub fn run()"));
  assert.ok(run.indexOf("pending_images.enqueue") < run.indexOf("tauri_plugin_single_instance::init"));
  const pageLoad = branchBetween(setup, "on_page_load(move |_webview, payload|", ".build()?");
  assert.match(pageLoad, /PageLoadEvent::Started[\s\S]*renderer_loading\(\)/);
});
