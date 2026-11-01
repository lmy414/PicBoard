import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TrayPanel from "./tray/TrayPanel";
import { bootstrapImageBoard, reportReady } from "./platform/bootstrap";
import { applyTheme, readTheme, startThemeSync } from "./ui/theme";
import "./styles.css";

// Resolve the theme before the first React paint (both the main window and the
// tray flyout) so a stored neumorphism preference never flashes the default.
applyTheme(readTheme());
startThemeSync();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("找不到应用挂载节点");
const root = ReactDOM.createRoot(rootElement);

async function start() {
  // Install the Tauri adapter before React mounts; without it the first
  // loadState would fail.
  try {
    await bootstrapImageBoard();
  } catch (caught) {
    // No usable desktop host: render the failure once rather than leaving a
    // blank window.
    root.render(
      <div className="loading-card">
        <strong>无法启动桌面宿主</strong>
        <span>{caught instanceof Error ? caught.message : String(caught)}</span>
      </div>,
    );
    return;
  }

  // The tray panel window renders F2's self-contained TrayPanel; the main
  // window renders the full app shell.
  if (new URLSearchParams(window.location.search).get("surface") === "tray") {
    document.documentElement.dataset.surface = "tray";
    root.render(
      <React.StrictMode>
        <TrayPanel />
      </React.StrictMode>,
    );
  } else {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  }
  // Report readiness after React committed its first frame so the host can
  // reveal the window and start the cursor publisher at a sane moment.
  requestAnimationFrame(() => requestAnimationFrame(() => reportReady()));
}

void start();
