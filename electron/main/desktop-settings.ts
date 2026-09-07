// Electron desktop-lifecycle host (mirror of the Rust `src-tauri/src/desktop/`
// contract): close behavior (float/tray/quit), system tray with
// 打开画板/收起/完全退出, launch-at-startup (release only, explicit user
// action), and the native directory picker.
//
// Conventions shared with the Rust host:
// - preference sidecar `desktop-settings.json` under the storage data root;
// - debug/dev builds never register auto-start (`autoStartAvailable = false`);
// - the real registry state is always read back, never fabricated;
// - host-initiated expansion changes are pushed to the renderer via
//   `window:expanded-changed`; React only listens (no recursion).

import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CloseBehavior, DesktopSettings } from "../shared";

export interface DesktopPreferenceFile {
  closeBehavior: CloseBehavior;
  autoStart?: boolean;
}

const DEFAULT_PREFS: DesktopPreferenceFile = { closeBehavior: "float", autoStart: false };
const FILE_NAME = "desktop-settings.json";
const TRAY_OPEN = "tray-open";
const TRAY_COLLAPSE = "tray-collapse";
const TRAY_QUIT = "tray-quit";

export interface DesktopHost {
  readonly prefsFile: string;
  tray: Tray | null;
  forceQuit: boolean;
  closeBehavior: CloseBehavior;
  autoStartAvailable: boolean;
}

function isDev(): boolean {
  return process.env.NODE_ENV === "development" || !app.isPackaged;
}

export function createDesktopHost(): DesktopHost {
  const dataRoot = path.join(app.getPath("userData"), "quick-image-board");
  return {
    prefsFile: path.join(dataRoot, FILE_NAME),
    tray: null,
    forceQuit: false,
    closeBehavior: DEFAULT_PREFS.closeBehavior,
    // Debug/dev never writes an auto-start entry.
    autoStartAvailable: !isDev() && process.platform === "win32",
  };
}

async function readPrefs(host: DesktopHost): Promise<DesktopPreferenceFile> {
  try {
    const raw = JSON.parse(await fs.readFile(host.prefsFile, "utf8")) as Partial<DesktopPreferenceFile>;
    const closeBehavior =
      raw.closeBehavior === "float" || raw.closeBehavior === "tray" || raw.closeBehavior === "quit"
        ? raw.closeBehavior
        : DEFAULT_PREFS.closeBehavior;
    return { closeBehavior, autoStart: raw.autoStart === true };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

async function writePrefs(host: DesktopHost, prefs: DesktopPreferenceFile): Promise<void> {
  await fs.mkdir(path.dirname(host.prefsFile), { recursive: true });
  await fs.writeFile(host.prefsFile, JSON.stringify(prefs, null, 2), "utf8");
}

/** Release-only launch-at-startup (current user, explicit user action). */
function setAutoStart(enabled: boolean): DesktopSettings["autoStart"] {
  if (!app.isPackaged || process.platform !== "win32") return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      // On Windows these two args keep the value aligned with the run target.
      args: [],
    });
  } catch (error) {
    console.error("[desktop] setLoginItemSettings failed:", error);
    return false;
  }
  return readAutoStart();
}

function readAutoStart(): DesktopSettings["autoStart"] {
  if (!app.isPackaged || process.platform !== "win32") return false;
  try {
    // Matches the same executable path we would register.
    return app.getLoginItemSettings({ path: process.execPath }).openAtLogin;
  } catch (error) {
    console.error("[desktop] getLoginItemSettings failed:", error);
    return false;
  }
}

export async function loadDesktopSettings(host: DesktopHost): Promise<void> {
  const prefs = await readPrefs(host);
  host.closeBehavior = prefs.closeBehavior;
}

export async function getDesktopSettings(host: DesktopHost): Promise<DesktopSettings> {
  return {
    closeBehavior: host.closeBehavior,
    autoStart: readAutoStart(),
    autoStartAvailable: host.autoStartAvailable,
  };
}

export async function setDesktopSettings(
  host: DesktopHost,
  patch: { closeBehavior?: CloseBehavior; autoStart?: boolean },
): Promise<DesktopSettings> {
  if (patch.closeBehavior) {
    const behavior: CloseBehavior =
      patch.closeBehavior === "float" || patch.closeBehavior === "tray" || patch.closeBehavior === "quit"
        ? patch.closeBehavior
        : host.closeBehavior;
    host.closeBehavior = behavior;
  }
  let autoStart = readAutoStart();
  if (patch.autoStart !== undefined) {
    if (!host.autoStartAvailable) {
      throw new Error("开发模式不注册开机启动（仅发布版可用）");
    }
    autoStart = setAutoStart(patch.autoStart);
    if (autoStart !== patch.autoStart) {
      throw new Error("系统启动项设置未能生效，请重试");
    }
  }
  const prefs: DesktopPreferenceFile = { closeBehavior: host.closeBehavior, autoStart };
  await writePrefs(host, prefs);
  return getDesktopSettings(host);
}

export async function pickDirectory(initialPath?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "选择目录偏好",
    properties: ["openDirectory", "createDirectory"],
  };
  if (initialPath) {
    const candidate = path.resolve(initialPath);
    // Only use an existing directory as the starting point; a stale preference
    // must never make the dialog fail to open.
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) options.defaultPath = candidate;
    } catch {
      // keep default
    }
  }
  const main = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = main
    ? await dialog.showOpenDialog(main, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/** Notify the renderer that the native expanded state changed (host-initiated). */
export function sendExpanded(window: BrowserWindow | null, expanded: boolean): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send("window:expanded-changed", expanded);
  }
}

interface TrayHandlers {
  open(): void;
  collapse(): void;
  quit(): void;
}

export function createTray(host: DesktopHost, handlers: TrayHandlers): Tray {
  const iconPath = path.join(__dirname, "../../../src-tauri/icons/icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("快捷图片画布");
  const menu = Menu.buildFromTemplate([
    { id: TRAY_OPEN, label: "打开画板", click: () => handlers.open() },
    { id: TRAY_COLLAPSE, label: "收起", click: () => handlers.collapse() },
    { type: "separator" },
    { id: TRAY_QUIT, label: "完全退出", click: () => handlers.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => handlers.open());
  host.tray = tray;
  return tray;
}
