import { app, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

const BALL_SETTINGS_KEY = "quick-image-board.ball-settings";
const PATH_SETTINGS_KEY = "quick-image-board.path-settings";

/**
 * Export the two renderer preference keys from Electron's localStorage.
 *
 * Invoked by `npm run export:prefs`. Creates a hidden BrowserWindow, loads the
 * production renderer under the same origin the app normally uses (file:// or
 * dist path), reads both localStorage keys with executeJavaScript, writes a
 * controlled JSON file, then exits. This never initializes the business
 * storage, never scans the whole profile and never touches the data root.
 */
async function main() {
  const target = process.env.QUICK_IMAGE_BOARD_PREFS_OUT;
  if (!target) throw new Error("QUICK_IMAGE_BOARD_PREFS_OUT 未设置");

  const window = new BrowserWindow({
    width: 200,
    height: 200,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const indexHtml = path.join(__dirname, "../../dist/index.html");
  await window.loadFile(indexHtml);
  const values = await window.webContents.executeJavaScript(
    `(() => {
      const read = (key) => {
        try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : undefined; }
        catch { return undefined; }
      };
      return {
        "${BALL_SETTINGS_KEY}": read("${BALL_SETTINGS_KEY}"),
        "${PATH_SETTINGS_KEY}": read("${PATH_SETTINGS_KEY}"),
      };
    })()`,
    true,
  );
  const payload = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
  await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
  window.destroy();
  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error("导出偏好失败:", error);
  app.exit(1);
});
