export type ImageStatus = "pending" | "classified";

export interface ImageRecord {
  id: string;
  fileName: string;
  relativePath: string;
  status: ImageStatus;
  categoryId: string | null;
  canvasId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: string;
  dataUrl?: string;
}

export interface CanvasRecord {
  id: string;
  name: string;
  imageIds: string[];
  createdAt: string;
  viewport: CanvasViewport;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CategoryRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface AppState {
  activeCanvasId: string;
  canvases: CanvasRecord[];
  categories: CategoryRecord[];
  images: Record<string, ImageRecord>;
  storageNotice?: string;
}

export interface ImportImagePayload {
  name: string;
  data: Uint8Array;
}

export interface ImportViewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface CursorPosition {
  x: number;
  y: number;
  windowX: number;
  windowY: number;
}

/** Window close behavior: collapse to floating ball, hide to tray, or quit. */
export type CloseBehavior = "float" | "tray" | "quit";

export interface DesktopSettings {
  closeBehavior: CloseBehavior;
  autoStart: boolean;
  autoStartAvailable: boolean;
}

export interface ImageBoardApi {
  loadState(): Promise<AppState>;
  importImages(canvasId: string, images: ImportImagePayload[], viewport?: ImportViewport): Promise<AppState>;
  pasteImage(canvasId: string): Promise<{ state: AppState; imported: boolean }>;
  setActiveCanvas(canvasId: string): Promise<AppState>;
  setCanvasViewport(canvasId: string, viewport: CanvasViewport): Promise<AppState>;
  createCanvas(): Promise<AppState>;
  renameCanvas(canvasId: string, name: string): Promise<AppState>;
  deleteCanvas(canvasId: string): Promise<AppState>;
  createCategory(name: string): Promise<AppState>;
  classifyImages(imageIds: string[], categoryId: string): Promise<AppState>;
  removeImageFromCanvas(imageId: string): Promise<AppState>;
  moveImage(imageId: string, x: number, y: number): Promise<AppState>;
  copyImageFiles(imageIds: string[]): Promise<{ copied: number }>;
  renameImage(imageId: string, name: string): Promise<AppState>;
  deleteClassifiedImages(imageIds: string[]): Promise<AppState>;
  getExpanded(): Promise<boolean>;
  setExpanded(expanded: boolean): Promise<void>;
  closeWindow(): Promise<void>;
  startWindowDrag(): Promise<void>;
  endWindowDrag(): Promise<void>;
  getDesktopSettings(): Promise<DesktopSettings>;
  setDesktopSettings(patch: { closeBehavior?: CloseBehavior; autoStart?: boolean }): Promise<DesktopSettings>;
  pickDirectory(initialPath?: string): Promise<string | null>;
  onCursorPosition(listener: (position: CursorPosition) => void): () => void;
  onExpandedChange(listener: (expanded: boolean) => void): () => void;
}

declare global {
  interface Window {
    imageBoard: ImageBoardApi;
  }
}
