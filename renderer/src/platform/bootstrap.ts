//! Tauri host bootstrap: install `window.imageBoard` before React mounts.
//!
//! Plain browser and legacy desktop hosts are rejected explicitly rather than
//! mounting a fake or incompatible state.

import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ImageBoardApi } from "../../../shared/image-board";
import { createTauriAdapter } from "./tauri-adapter";

function reportReady() {
  // The host listens for this event to reveal the window and start the cursor
  // publisher. Fire-and-forget and never fatal.
  emit("host:ready", {}).catch(() => undefined);
}

export { reportReady };

export interface BootstrapResult {
  host: "tauri";
  imageBoard: ImageBoardApi;
}

export async function bootstrapImageBoard(): Promise<BootstrapResult> {
  if (!isTauri()) {
    throw new Error("未检测到 Tauri 桌面宿主：请通过 Rust/Tauri 启动本应用");
  }
  const imageBoard = createTauriAdapter();
  window.imageBoard = imageBoard;
  return { host: "tauri", imageBoard };
}
