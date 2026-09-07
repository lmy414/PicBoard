import { contextBridge, ipcRenderer } from "electron";
import type { CursorPosition, ImageBoardApi, ImportImagePayload, ImportViewport } from "../shared";

const api: ImageBoardApi = {
  loadState: () => ipcRenderer.invoke("store:load"),
  importImages: (canvasId, images: ImportImagePayload[], viewport?: ImportViewport) =>
    ipcRenderer.invoke("store:import-images", canvasId, images, viewport),
  pasteImage: (canvasId) => ipcRenderer.invoke("store:paste-image", canvasId),
  setActiveCanvas: (canvasId) => ipcRenderer.invoke("store:set-active-canvas", canvasId),
  setCanvasViewport: (canvasId, viewport) => ipcRenderer.invoke("store:set-canvas-viewport", canvasId, viewport),
  createCanvas: () => ipcRenderer.invoke("store:create-canvas"),
  renameCanvas: (canvasId, name) =>
    ipcRenderer.invoke("store:rename-canvas", canvasId, name),
  deleteCanvas: (canvasId) =>
    ipcRenderer.invoke("store:delete-canvas", canvasId),
  createCategory: (name) => ipcRenderer.invoke("store:create-category", name),
  classifyImages: (imageIds, categoryId) =>
    ipcRenderer.invoke("store:classify-images", imageIds, categoryId),
  removeImageFromCanvas: (imageId) =>
    ipcRenderer.invoke("store:remove-image", imageId),
  moveImage: (imageId, x, y) =>
    ipcRenderer.invoke("store:move-image", imageId, x, y),
  copyImageFiles: (imageIds) =>
    ipcRenderer.invoke("store:copy-files", imageIds),
  setExpanded: (expanded) => ipcRenderer.invoke("window:set-expanded", expanded),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  startWindowDrag: () => ipcRenderer.invoke("window:drag-start"),
  endWindowDrag: () => ipcRenderer.invoke("window:drag-end"),
  onCursorPosition: (listener: (position: CursorPosition) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, position: CursorPosition) => listener(position);
    ipcRenderer.on("window:cursor-position", handler);
    return () => ipcRenderer.removeListener("window:cursor-position", handler);
  },
};

contextBridge.exposeInMainWorld("imageBoard", api);
