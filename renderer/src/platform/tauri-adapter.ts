//! Tauri host adapter: implements the `window.imageBoard` shape (see
//! `shared/image-board.ts`) on top of `@tauri-apps/api` core/event.
//!
//! - Command names and argument keys are 1:1 with the Rust commands: calls use
//!   snake_case commands and camelCase argument keys, as required by Tauri.
//! - `Uint8Array` payloads are passed through as-is; Tauri's IPC serializer
//!   converts them to byte arrays on the wire and Rust receives `Vec<u8>`.
//! - Event registration is asynchronous (`listen` returns a Promise), but the
//!   public subscriptions must return a synchronous unsubscribe function, so
//!   one bridge adapts every host event.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppState,
  CanvasFrame,
  CanvasPoint,
  CanvasViewport,
  ContentAsset,
  ContentBody,
  CreateContentNodeResult,
  DesktopSettings,
  DesktopSettingsPatch,
  ImageBoardApi,
  ImportImagePayload,
  ImportViewport,
  MainNavigation,
  NewContentInput,
  NodeMove,
  PluginListing,
} from "../../../shared/image-board";

function toError(caught: unknown): Error {
  if (caught instanceof Error) return caught;
  return new Error(typeof caught === "string" ? caught : "host 调用失败");
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (caught) {
    throw toError(caught);
  }
}

/** Bridge the async `listen` promise to the synchronous unsubscribe of the API. */
function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  const ready = listen<T>(event, (message) => listener(message.payload))
    .then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    })
    .catch((caught) => {
      console.error(`${event} subscription failed`, caught);
    });
  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = undefined;
      return;
    }
    // Unsubscribed before the async listen resolved; drop it when ready.
    void ready.then(() => {
      if (unlisten) {
        unlisten();
        unlisten = undefined;
      }
    });
  };
}

export function createTauriAdapter(): ImageBoardApi {
  return {
    readImage: (contentId) => call("read_image", { contentId }),
    saveImageCopy: (image) => call("save_image_copy", { image }),
    exportImage: (image) => call("export_image", { image }),
    openImageFile: () => call("open_image_file"),
    takePendingImage: () => call("take_pending_image"),
    onImageOpened: (listener) => subscribe("image:opened", listener),
    getImageAssociation: () => call("get_image_association"),
    configureImageAssociation: () => call("configure_image_association"),
    loadState: () => call<AppState>("load_state"),
    onStateChanged: (listener) => subscribe<AppState>("state-changed", listener),
    pasteClipboard: (canvasId: string, viewport?: ImportViewport) =>
      call<{ state: AppState; placed: boolean }>("paste_clipboard", { canvasId, viewport }),
    placeContent: (contentId: string, canvasId: string, center: CanvasPoint) =>
      call<AppState>("place_content", { contentId, canvasId, center }),
    createContentNode: (canvasId: string, center: CanvasPoint, input: NewContentInput) =>
      call<CreateContentNodeResult>("create_content_node", { canvasId, center, input }),
    setActiveCanvas: (canvasId: string) => call<AppState>("set_active_canvas", { canvasId }),
    setCanvasViewport: (canvasId: string, viewport: CanvasViewport) =>
      call<AppState>("set_canvas_viewport", { canvasId, viewport }),
    createCanvas: (parentId?: string | null, frame?: CanvasFrame) =>
      call<AppState>("create_canvas", { parentId: parentId ?? null, frame }),
    moveCanvas: (canvasId: string, parentId: string | null, index?: number) =>
      call<AppState>("move_canvas", { canvasId, parentId, index }),
    setCanvasFrame: (canvasId: string, frame: CanvasFrame) =>
      call<AppState>("set_canvas_frame", { canvasId, frame }),
    groupNodesIntoCanvas: (nodeIds: string[]) =>
      call<AppState>("group_nodes_into_canvas", { nodeIds }),
    ungroupCanvas: (canvasId: string) => call<AppState>("ungroup_canvas", { canvasId }),
    moveNodesToCanvas: (nodeIds: string[], targetCanvasId: string, origin: CanvasPoint) =>
      call<AppState>("move_nodes_to_canvas", { nodeIds, targetCanvasId, origin }),
    renameCanvas: (canvasId: string, name: string) =>
      call<AppState>("rename_canvas", { canvasId, name }),
    deleteCanvas: (canvasId: string) => call<AppState>("delete_canvas", { canvasId }),
    moveNodes: (moves: NodeMove[]) => call<AppState>("move_nodes", { moves }),
    removeNodes: (nodeIds: string[]) => call<AppState>("remove_nodes", { nodeIds }),
    createEdge: (fromNodeId: string, toNodeId: string) =>
      call<AppState>("create_edge", { fromNodeId, toNodeId }),
    deleteEdges: (edgeIds: string[]) => call<AppState>("delete_edges", { edgeIds }),
    getContentBody: (contentId: string) =>
      call<ContentBody>("get_content_body", { contentId }),
    updateTextContent: (contentId: string, body: ContentBody) =>
      call<AppState>("update_text_content", { contentId, body }),
    addContentAsset: (contentId: string, image: ImportImagePayload) =>
      call<ContentAsset>("add_content_asset", { contentId, image }),
    assetUrl: (contentId: string, assetId: string, variant: "thumb" | "full") =>
      convertFileSrc(`${variant === "thumb" ? "asset-thumb" : "asset"}/${contentId}/${assetId}`, "picboard"),
    updateLinkContent: (contentId: string, url: string) =>
      call<AppState>("update_link_content", { contentId, url }),
    renameImage: (contentId: string, name: string) =>
      call<AppState>("rename_image", { contentId, name }),
    deleteContents: (contentIds: string[]) =>
      call<AppState>("delete_contents", { contentIds }),
    copyContents: (contentIds: string[]) =>
      call<{ copied: number }>("copy_contents", { contentIds }),
    createCategory: (name: string) => call<AppState>("create_category", { name }),
    classifyContents: (contentIds: string[], categoryId: string | null) =>
      call<AppState>("classify_contents", { contentIds, categoryId }),
    imageUrl: (contentId: string, variant: "thumb" | "full") =>
      convertFileSrc(`${variant}/${contentId}`, "picboard"),
    openExternalUrl: (url: string) => call<void>("open_external_url", { url }),
    listPlugins: () => call<PluginListing>("list_plugins"),
    startTitlebarDrag: () => call<void>("start_titlebar_drag"),
    toggleMaximized: () => call<boolean>("toggle_maximized"),
    isMaximized: () => call<boolean>("is_maximized"),
    closeWindow: () => call<void>("close_window"),
    minimizeWindow: () => call<void>("minimize_window"),
    quitApp: () => call<void>("quit_app"),
    showMainWindow: (navigate?: MainNavigation) =>
      call<void>("show_main_window", { navigate: navigate ?? null }),
    hideTrayPanel: () => call<void>("hide_tray_panel"),
    getDesktopSettings: () => call<DesktopSettings>("get_desktop_settings"),
    setDesktopSettings: (patch: DesktopSettingsPatch) =>
      call<DesktopSettings>("set_desktop_settings", { patch }),
    pickDirectory: (initialPath?: string) =>
      call<string | null>("pick_directory", { initialPath }),
    onNavigate: (listener: (navigate: MainNavigation) => void) =>
      subscribe<MainNavigation>("main:navigate", listener),
  };
}
