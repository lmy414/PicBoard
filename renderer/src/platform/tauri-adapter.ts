//! Tauri host adapter: implements the `window.imageBoard` shape (see
//! `shared/image-board.ts`) on top of `@tauri-apps/api` core/event.
//!
//! - Command/argument/return naming is 1:1 with the Rust commands.
//! - `Uint8Array` payloads are passed through as-is; Tauri's IPC serializer
//!   converts them to byte arrays on the wire and Rust receives `Vec<u8>`.
//! - Event registration is asynchronous (`listen` returns a Promise), but the
//!   public `onCursorPosition` must return a synchronous unsubscribe function,
//!   so the adapter bridges an async `ready` promise to a sync API. The
//!   listener set is created once; each call site gets its own unsubscribe.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppState,
  CanvasViewport,
  CloseBehavior,
  CursorPosition,
  DesktopSettings,
  ImageBoardApi,
  ImportImagePayload,
  ImportViewport,
} from "../../../shared/image-board";

function toError(caught: unknown): Error {
  if (caught instanceof Error) return caught;
  const message = typeof caught === "string" ? caught : "host 调用失败";
  return new Error(message);
}

/** Tauri command names mirror the Rust `#[tauri::command]` fns. */
function commandName(tsName: string): string {
  const map: Record<string, string> = {
    loadState: "load_state",
    importImages: "import_images",
    pasteImage: "paste_image",
    setActiveCanvas: "set_active_canvas",
    setCanvasViewport: "set_canvas_viewport",
    createCanvas: "create_canvas",
    renameCanvas: "rename_canvas",
    deleteCanvas: "delete_canvas",
    createCategory: "create_category",
    classifyImages: "classify_images",
    removeImageFromCanvas: "remove_image_from_canvas",
    moveImage: "move_image",
    copyImageFiles: "copy_image_files",
    getExpanded: "get_expanded",
    setExpanded: "set_expanded",
    closeWindow: "close_window",
    startWindowDrag: "start_window_drag",
    endWindowDrag: "end_window_drag",
    getDesktopSettings: "get_desktop_settings",
    setDesktopSettings: "set_desktop_settings",
    pickDirectory: "pick_directory",
  };
  return map[tsName] ?? tsName;
}

async function call<T>(tsName: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(commandName(tsName), args);
  } catch (caught) {
    throw toError(caught);
  }
}

export function createTauriAdapter(): ImageBoardApi {
  const api: ImageBoardApi = {
    loadState: () => call<AppState>("loadState"),
    importImages: (canvasId: string, images: ImportImagePayload[], viewport?: ImportViewport) =>
      call<AppState>("importImages", { canvasId, images, viewport }),
    pasteImage: (canvasId: string) =>
      call<{ state: AppState; imported: boolean }>("pasteImage", { canvasId }),
    setActiveCanvas: (canvasId: string) => call<AppState>("setActiveCanvas", { canvasId }),
    setCanvasViewport: (canvasId: string, viewport: CanvasViewport) =>
      call<AppState>("setCanvasViewport", { canvasId, viewport }),
    createCanvas: () => call<AppState>("createCanvas"),
    renameCanvas: (canvasId: string, name: string) =>
      call<AppState>("renameCanvas", { canvasId, name }),
    deleteCanvas: (canvasId: string) => call<AppState>("deleteCanvas", { canvasId }),
    createCategory: (name: string) => call<AppState>("createCategory", { name }),
    classifyImages: (imageIds: string[], categoryId: string) =>
      call<AppState>("classifyImages", { imageIds, categoryId }),
    removeImageFromCanvas: (imageId: string) =>
      call<AppState>("removeImageFromCanvas", { imageId }),
    moveImage: (imageId: string, x: number, y: number) =>
      call<AppState>("moveImage", { imageId, x, y }),
    copyImageFiles: (imageIds: string[]) =>
      call<{ copied: number }>("copyImageFiles", { imageIds }),
    getExpanded: () => call<boolean>("getExpanded"),
    setExpanded: (expanded: boolean) => call<void>("setExpanded", { expanded }),
    closeWindow: () => call<void>("closeWindow"),
    startWindowDrag: () => call<void>("startWindowDrag"),
    endWindowDrag: () => call<void>("endWindowDrag"),
    getDesktopSettings: () => call<DesktopSettings>("getDesktopSettings"),
    setDesktopSettings: (patch: { closeBehavior?: CloseBehavior; autoStart?: boolean }) =>
      call<DesktopSettings>("setDesktopSettings", { patch }),
    pickDirectory: (initialPath?: string) =>
      call<string | null>("pickDirectory", { initialPath }),
    onCursorPosition: (listener: (position: CursorPosition) => void) => {
      // Event plumbing is async; the unsubscribe is synchronous once ready.
      let unlisten: (() => void) | undefined;
      let disposed = false;
      const ready = listen<CursorPosition>("window:cursor-position", (event) => {
        listener(event.payload);
      }).then((fn) => {
        if (disposed) {
          void fn();
        } else {
          unlisten = fn;
        }
      }).catch((caught) => {
        console.error("cursor event subscription failed", caught);
      });
      return () => {
        disposed = true;
        if (unlisten) {
          unlisten();
          unlisten = undefined;
        } else {
          // Unsubscribed before the async listen resolved; drop it when ready.
          void ready.then(() => {
            if (unlisten) {
              unlisten();
              unlisten = undefined;
            }
          });
        }
      };
    },
    onExpandedChange: (listener: (expanded: boolean) => void) => {
      // Host/tray/close actions emit `window:expanded-changed`; React listens
      // and never re-invokes, so no recursion. Same async-bridge pattern as
      // the cursor subscription above.
      let unlisten: (() => void) | undefined;
      let disposed = false;
      const ready = listen<boolean>("window:expanded-changed", (event) => {
        listener(event.payload);
      }).then((fn) => {
        if (disposed) {
          void fn();
        } else {
          unlisten = fn;
        }
      }).catch((caught) => {
        console.error("expanded event subscription failed", caught);
      });
      return () => {
        disposed = true;
        if (unlisten) {
          unlisten();
          unlisten = undefined;
        } else {
          void ready.then(() => {
            if (unlisten) {
              unlisten();
              unlisten = undefined;
            }
          });
        }
      };
    },
  };
  return api;
}
