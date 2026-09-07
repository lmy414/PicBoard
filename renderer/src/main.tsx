import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootstrapImageBoard, reportReady } from "./platform/bootstrap";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("找不到应用挂载节点");
const root = ReactDOM.createRoot(rootElement);

async function start() {
  // Install `window.imageBoard` (Tauri adapter or keep Electron preload object)
  // before React mounts; without it App's initial loadState would fail.
  try {
    await bootstrapImageBoard();
  } catch (caught) {
    // No usable desktop host: render the failure once rather than leaving a
    // blank window. App handles window.imageBoard absence by showing its
    // load-error state only after a failed call; showing a direct message is
    // clearer for a misconfigured browser run.
    root.render(
      <div className="loading-card">
        <strong>无法启动桌面宿主</strong>
        <span>{caught instanceof Error ? caught.message : String(caught)}</span>
      </div>,
    );
    return;
  }

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  // Report readiness after React committed its first frame so the host can
  // reveal the window and start the cursor publisher at a sane moment.
  requestAnimationFrame(() => requestAnimationFrame(() => reportReady()));
}

void start();
