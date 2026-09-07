import { app, BrowserWindow, clipboard, ipcMain, screen } from "electron";
import path from "node:path";
import { createStorage } from "./storage";
import { createWindowGeometryState, fitWindowToWorkArea, transitionWindowExpansion, type WindowGeometryState } from "./window-geometry";
import { createWindowsFileClipboardWriter } from "./windows-clipboard";
import {
  createDesktopHost,
  createTray,
  getDesktopSettings,
  loadDesktopSettings,
  pickDirectory,
  sendExpanded,
  setDesktopSettings,
  type DesktopHost,
} from "./desktop-settings";
import type { CloseBehavior, ImportImagePayload, ImportViewport } from "../shared";

let mainWindow: BrowserWindow | null = null;
let storage: ReturnType<typeof createStorage> | null = null;
let desktopHost: DesktopHost = createDesktopHost();
let cursorTimer: ReturnType<typeof setInterval> | null = null;
let windowDragTimer: ReturnType<typeof setInterval> | null = null;
let windowDragStart: { cursorX: number; cursorY: number; windowX: number; windowY: number; width: number; height: number } | null = null;
let windowDragLastPosition: { x: number; y: number } | null = null;
let windowGeometryState: WindowGeometryState = createWindowGeometryState();

function getStorage() {
  if (!storage) throw new Error("本地存储尚未初始化");
  return storage;
}

function setWindowSize(isExpanded: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const display = !isExpanded && windowGeometryState.collapsedBounds
    ? screen.getDisplayMatching(windowGeometryState.collapsedBounds)
    : screen.getDisplayMatching(current);
  const transition = transitionWindowExpansion(current, display.workArea, isExpanded, windowGeometryState);
  windowGeometryState = transition.state;
  if (transition.changed) mainWindow.setBounds(transition.bounds, true);
}

function stopCursorTracking() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
}

function startCursorTracking() {
  stopCursorTracking();
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || windowDragStart) return;
    const bounds = mainWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    mainWindow.webContents.send("window:cursor-position", { x: cursor.x, y: cursor.y, windowX: bounds.x, windowY: bounds.y });
  }, 50);
}

function stopWindowDrag() {
  if (windowDragTimer) clearInterval(windowDragTimer);
  if (windowDragStart) moveWindowFromCursor();
  windowDragTimer = null;
  windowDragStart = null;
  windowDragLastPosition = null;
  if (mainWindow && !mainWindow.isDestroyed()) startCursorTracking();
}

function moveWindowFromCursor() {
  if (!mainWindow || mainWindow.isDestroyed() || !windowDragStart) return;
  const cursor = screen.getCursorScreenPoint();
  const candidate = {
    x: windowDragStart.windowX + cursor.x - windowDragStart.cursorX,
    y: windowDragStart.windowY + cursor.y - windowDragStart.cursorY,
    width: windowDragStart.width,
    height: windowDragStart.height,
  };
  const display = screen.getDisplayMatching(candidate);
  const fitted = fitWindowToWorkArea(candidate, display.workArea, false);
  if (!windowDragLastPosition || fitted.x !== windowDragLastPosition.x || fitted.y !== windowDragLastPosition.y) {
    mainWindow.setPosition(fitted.x, fitted.y, false);
    windowDragLastPosition = { x: fitted.x, y: fitted.y };
  }
}

function startWindowDrag() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowDragStart) return;
  stopCursorTracking();
  const bounds = mainWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  windowDragStart = { cursorX: cursor.x, cursorY: cursor.y, windowX: bounds.x, windowY: bounds.y, width: bounds.width, height: bounds.height };
  moveWindowFromCursor();
  windowDragTimer = setInterval(moveWindowFromCursor, 8);
}

function createWindow() {
  windowGeometryState = createWindowGeometryState();
  const workArea = screen.getPrimaryDisplay().workArea;
  mainWindow = new BrowserWindow({
    width: 88,
    height: 88,
    x: workArea.x + workArea.width - 112,
    y: workArea.y + 20,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Window close honors the user's close behavior (float/tray/quit).
  mainWindow.on("close", (event) => {
    if (desktopHost.forceQuit || desktopHost.closeBehavior === "quit") {
      return; // allow close
    }
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    event.preventDefault();
    if (desktopHost.closeBehavior === "tray") {
      win.hide();
    } else {
      // float: collapse to the floating 88x88 ball through the geometry-aware
      // path so a later tray open can still restore the expanded bounds.
      setWindowSize(false);
    }
    // Both cases hide the board; React must follow via the same host event
    // used by the Rust host.
    sendExpanded(win, false);
  });

  const devUrl = process.env.NODE_ENV === "development" ? "http://127.0.0.1:5173" : null;
  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  };
  mainWindow.once("ready-to-show", showWindow);
  mainWindow.webContents.once("did-finish-load", showWindow);
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
    showWindow();
  });
  const loadPromise = devUrl ? mainWindow.loadURL(devUrl) : mainWindow.loadFile(path.join(__dirname, "../../../dist/index.html"));
  void loadPromise.catch((error) => {
    console.error("Failed to load renderer:", error);
    showWindow();
  });
  mainWindow.on("closed", () => {
    stopCursorTracking();
    if (windowDragTimer) clearInterval(windowDragTimer);
    windowDragTimer = null;
    windowDragStart = null;
    windowDragLastPosition = null;
    mainWindow = null;
  });
  startCursorTracking();
}

function registerIpc() {
  ipcMain.handle("store:load", () => getStorage().loadState());
  ipcMain.handle("store:import-images", (_event, canvasId: string, images: ImportImagePayload[], viewport?: ImportViewport) =>
    getStorage().importImages(canvasId, images, viewport),
  );
  ipcMain.handle("store:paste-image", (_event, canvasId: string) => getStorage().pasteImage(canvasId));
  ipcMain.handle("store:set-active-canvas", (_event, canvasId: string) => getStorage().setActiveCanvas(canvasId));
  ipcMain.handle("store:set-canvas-viewport", (_event, canvasId: string, viewport) => getStorage().setCanvasViewport(canvasId, viewport));
  ipcMain.handle("store:create-canvas", () => getStorage().createCanvasRecord());
  ipcMain.handle("store:rename-canvas", (_event, canvasId: string, name: string) =>
    getStorage().renameCanvas(canvasId, name),
  );
  ipcMain.handle("store:delete-canvas", (_event, canvasId: string) => getStorage().deleteCanvas(canvasId));
  ipcMain.handle("store:create-category", (_event, name: string) => getStorage().createCategoryRecord(name));
  ipcMain.handle("store:classify-images", (_event, imageIds: string[], categoryId: string) =>
    getStorage().classifyImages(imageIds, categoryId),
  );
  ipcMain.handle("store:remove-image", (_event, imageId: string) =>
    getStorage().removeImageFromCanvas(imageId),
  );
  ipcMain.handle("store:move-image", (_event, imageId: string, x: number, y: number) =>
    getStorage().moveImage(imageId, x, y),
  );
  ipcMain.handle("store:copy-files", (_event, imageIds: string[]) => getStorage().copyImageFiles(imageIds));
  ipcMain.handle("window:set-expanded", (_event, isExpanded: boolean) => {
    setWindowSize(isExpanded);
  });
  ipcMain.handle("window:drag-start", () => startWindowDrag());
  ipcMain.handle("window:drag-end", () => stopWindowDrag());
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("desktop:get-settings", () => getDesktopSettings(desktopHost));
  ipcMain.handle("desktop:set-settings", (_event, patch: { closeBehavior?: CloseBehavior; autoStart?: boolean }) =>
    setDesktopSettings(desktopHost, patch),
  );
  ipcMain.handle("desktop:pick-directory", (_event, initialPath?: string) => pickDirectory(initialPath));
}

app.whenReady().then(async () => {
  storage = createStorage({ rootDir: path.join(app.getPath("userData"), "quick-image-board"), clipboard, fileClipboard: process.platform === "win32" ? createWindowsFileClipboardWriter() : undefined });
  await loadDesktopSettings(desktopHost);
  registerIpc();
  createWindow();
  createTray(desktopHost, {
    open: () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
      }
      // Restore from tray/ball: expand + show + notify React.
      setWindowSize(true);
      mainWindow.show();
      mainWindow.focus();
      sendExpanded(mainWindow, true);
    },
    collapse: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        setWindowSize(false);
        sendExpanded(mainWindow, false);
      }
    },
    quit: () => {
      desktopHost.forceQuit = true;
      app.quit();
    },
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // float/tray intercept the close, so this only fires on a genuine quit
  // (closeBehavior "quit" or the tray's forceQuit path).
  if (process.platform !== "darwin") app.quit();
});
