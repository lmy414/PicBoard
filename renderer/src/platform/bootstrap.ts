//! Host bootstrap: detect the real host and install `window.imageBoard` before
//! React mounts.
//!
//! - Electron: the preload already injected the object; leave it untouched.
//! - Tauri/WebView2: install the adapter built on `@tauri-apps/api`.
//! - Plain browser: fail loudly with a readable error rather than mount a fake
//!   empty state.

import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ImageBoardApi } from "../../../shared/image-board";
import { createTauriAdapter } from "./tauri-adapter";
import { applyBootstrapPreferences, loadBootstrapPreferences } from "./preferences";

function reportReady() {
  // The host listens for this event to reveal the window and start the cursor
  // publisher. Fire-and-forget and never fatal.
  emit("host:ready", {}).catch(() => undefined);
}

export { reportReady };

export interface BootstrapResult {
  host: "tauri" | "electron";
  imageBoard: ImageBoardApi;
}

export async function bootstrapImageBoard(): Promise<BootstrapResult> {
  if (window.imageBoard) {
    // Electron preload (or another host) already installed the bridge.
    await loadBootstrapPreferences().then(applyBootstrapPreferences);
    return { host: "electron", imageBoard: window.imageBoard };
  }
  if (isTauri()) {
    // Preferences must be seeded before React initializes default-state
    // effects; the adapter must be visible before `loadState` is called.
    await loadBootstrapPreferences().then(applyBootstrapPreferences);
    const imageBoard = createTauriAdapter();
    window.imageBoard = imageBoard;
    return { host: "tauri", imageBoard };
  }
  throw new Error("未检测到桌面宿主：请在 Tauri 或 Electron 中运行本应用");
}
