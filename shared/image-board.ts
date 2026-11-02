/** Content kinds PicBoard collects from the clipboard and drops. */
export type ContentKind = "text" | "richText" | "link" | "image";

/** How a content first entered PicBoard. */
export type ContentSource = "clipboard" | "paste" | "drop" | "migrated" | "manual";

export interface ImageInfo {
  fileName: string;
  /** Data-root-relative path; host-internal. The renderer loads pixels via `imageUrl()`. */
  relativePath: string;
  /** Intrinsic pixel size; 0 when unknown. */
  width: number;
  height: number;
  byteSize: number;
}

/**
 * One collected item. Stored once and referenced by any number of canvas
 * nodes (multi-reference), so editing it updates every placement.
 */
export interface ContentRecord {
  id: string;
  kind: ContentKind;
  /**
   * Plain-text summary for cards, history and search. text/richText: leading
   * plain text (at most 500 chars, newlines kept); link: the URL; image: the
   * file name.
   */
  preview: string;
  /** Full plain-text length in chars for text/richText; 0 otherwise. */
  textLength: number;
  /** link only: absolute http(s) URL; null otherwise. */
  url: string | null;
  /** image only; null otherwise. */
  image: ImageInfo | null;
  /** "<contentId>/<assetId>" of the first image inside a richText content; null otherwise. */
  coverAsset: string | null;
  categoryId: string | null;
  source: ContentSource;
  createdAt: string;
  updatedAt: string;
  /**
   * Recency and retention clock. Bumped by capture, identical re-capture,
   * paste, placement, removal from a canvas, copy-out and edits. The clipboard
   * history lists contents by it, newest first.
   */
  lastUsedAt: string;
}

/** Full body of a text/richText content, loaded on demand. */
export interface ContentBody {
  text: string;
  /** Rich HTML for richText; null for plain text. */
  html: string | null;
}

/** Image stored inside a text/richText content, referenced from its HTML. */
export interface ContentAsset {
  assetId: string;
  mime: string;
  width: number;
  height: number;
  byteSize: number;
}

/** One placement of a content on a canvas (JSON Canvas–style node). */
export interface CanvasNode {
  id: string;
  contentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Final world position of one node in a move gesture. */
export interface NodeMove {
  nodeId: string;
  x: number;
  y: number;
}

/** Allowed canvas grid spacings in world units. */
export type GridSize = 16 | 24 | 32;

/**
 * Directed relation edge between two canvas nodes; the arrow points at
 * `toNode`. Edges are global. A canvas draws an edge when both ends resolve on
 * it: a node placed directly on that canvas, or, for a node nested anywhere
 * inside a sub-canvas, the card of the direct child canvas that contains it.
 * If either end does not resolve, or both ends resolve to the same card, the
 * edge is hidden on that canvas.
 */
export interface EdgeRecord {
  id: string;
  fromNode: string;
  toNode: string;
  createdAt: string;
}

/**
 * Placement of a child canvas card on its parent canvas, in parent world
 * coordinates. The card is a collapsed node-group handle (Blender model):
 * child content is only visible after entering the sub-canvas.
 */
export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasRecord {
  id: string;
  name: string;
  /** Parent canvas id; null for root canvases. Nesting is unbounded. */
  parentId: string | null;
  /** Card placement on the parent canvas; null for root canvases. */
  frame: CanvasFrame | null;
  /** Content placements on this canvas, bottom-to-top z-order. */
  nodes: CanvasNode[];
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
  /** Monotonic host write counter; renderers drop snapshots older than the one they hold. */
  revision: number;
  activeCanvasId: string;
  canvases: CanvasRecord[];
  categories: CategoryRecord[];
  contents: Record<string, ContentRecord>;
  edges: EdgeRecord[];
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

export interface CanvasPoint {
  x: number;
  y: number;
}

/**
 * Window close behavior: hide into the system tray (default) or quit. The
 * tray panel window is independent of this choice.
 */
export type CloseBehavior = "tray" | "quit";

/** View/content navigation requested for the main window (tray panel → main). */
export interface MainNavigation {
  view?: "canvas" | "library" | "settings";
  contentId?: string;
}

/** Allowed history retention periods in days; 0 keeps history forever. */
export type HistoryRetentionDays = 0 | 7 | 30 | 90 | 365;

export interface DesktopSettings {
  closeBehavior: CloseBehavior;
  autoStart: boolean;
  autoStartAvailable: boolean;
  /** Background clipboard recording; false means paused. Default true. */
  captureEnabled: boolean;
  /** Contents with no placement and no category whose lastUsedAt is older than this are deleted. Default 30. */
  historyRetentionDays: HistoryRetentionDays;
  /** Canvas manipulation snaps placements to `gridSize`; Alt inverts it for one gesture. Default false (free mode). */
  snapToGrid: boolean;
  /** Canvas grid spacing and the host's snap step. Default 24. */
  gridSize: GridSize;
}

export interface DesktopSettingsPatch {
  closeBehavior?: CloseBehavior;
  autoStart?: boolean;
  captureEnabled?: boolean;
  historyRetentionDays?: HistoryRetentionDays;
  snapToGrid?: boolean;
  gridSize?: GridSize;
}

/** One folder under `<dataRoot>/plugins/`; the renderer plugin host validates it. */
export interface PluginSource {
  folder: string;
  /** Parsed manifest.json, not validated by the host. */
  manifest: unknown;
  /** Entry script source text. */
  code: string;
}

export interface PluginListing {
  /** Absolute plugins directory; created if missing. */
  directory: string;
  plugins: PluginSource[];
  errors: Array<{ folder: string; message: string }>;
}

/**
 * Body of a content created from the canvas new-node menu. Each call creates a
 * fresh content; it never reuses a matching history item.
 */
export type NewContentInput =
  | { kind: "text" }
  | { kind: "richText" }
  | { kind: "link"; url: string };

/** The new node's content and placement, plus the state after the write. */
export interface CreateContentNodeResult {
  state: AppState;
  contentId: string;
  nodeId: string;
}

export interface ImageBoardApi {
  readImage(contentId: string): Promise<{ data: number[]; mime: string }>;
  saveImageCopy(image: ImportImagePayload): Promise<{ state: AppState; contentId: string }>;
  exportImage(image: ImportImagePayload): Promise<string | null>;
  openImageFile(): Promise<{ state: AppState; contentId: string } | null>;
  takePendingImage(): Promise<{ state: AppState; contentId: string } | null>;
  onImageOpened(listener: (result: { state: AppState; contentId: string }) => void): () => void;
  getImageAssociation(): Promise<{ available: boolean; registered: boolean }>;
  configureImageAssociation(): Promise<void>;
  loadState(): Promise<AppState>;
  /**
   * Host push after every mutation: command results from either window,
   * background clipboard capture and retention cleanup all broadcast
   * "state-changed" to all windows. Drop snapshots older than the held revision.
   */
  onStateChanged(listener: (state: AppState) => void): () => void;
  /** Ctrl+V in the panel: read the system clipboard (any supported kind) and place it on the canvas, reusing the newest history item when identical. The host may snap and relocate the result so nothing overlaps another node or card (GAP 16 px). */
  pasteClipboard(canvasId: string, viewport?: ImportViewport): Promise<{ state: AppState; placed: boolean }>;
  /** Place an existing content on a canvas; `center` is the node center in that canvas's world coordinates. The host may snap the node and relocate it to the nearest free spot so it never overlaps another node or card (GAP 16 px). */
  placeContent(contentId: string, canvasId: string, center: CanvasPoint): Promise<AppState>;
  /**
   * Create a fresh text/rich-text/link content and place its first node centered
   * on `center` in that canvas's world coordinates. A new rich-text content
   * starts as an empty rich document (never a plain-text body). The host snaps
   * the node and relocates it to the nearest free spot like `placeContent`.
   */
  createContentNode(
    canvasId: string,
    center: CanvasPoint,
    input: NewContentInput,
  ): Promise<CreateContentNodeResult>;
  setActiveCanvas(canvasId: string): Promise<AppState>;
  setCanvasViewport(canvasId: string, viewport: CanvasViewport): Promise<AppState>;
  createCanvas(parentId?: string | null, frame?: CanvasFrame): Promise<AppState>;
  /** Re-parent a canvas (null = root) and optionally reorder among siblings. Rejects moving a canvas under its own descendant. Auto-places the card when the parent changes. */
  moveCanvas(canvasId: string, parentId: string | null, index?: number): Promise<AppState>;
  /** Move/resize a child canvas card on its parent canvas. The host snaps the frame and relocates the card to the nearest free spot so it never overlaps another node or card (GAP 16 px). */
  setCanvasFrame(canvasId: string, frame: CanvasFrame): Promise<AppState>;
  /** Blender-style group: nodes of one canvas move into a new sub-canvas whose card covers their bounding box. Node ids are preserved, so edges follow. The host may snap and relocate the new card so nothing overlaps (GAP 16 px). */
  groupNodesIntoCanvas(nodeIds: string[]): Promise<AppState>;
  /** Dissolve a sub-canvas one level: its nodes and child canvases move onto the parent canvas, the canvas itself is removed. The host may snap and relocate the brought-in items so nothing overlaps (GAP 16 px). */
  ungroupCanvas(canvasId: string): Promise<AppState>;
  /** Move nodes to another canvas. `origin` is the point in the source canvas world that maps to the target's local (0,0), the card frame origin when dropping onto a card. Node ids are preserved. The host may snap and relocate the moved set so nothing overlaps (GAP 16 px). */
  moveNodesToCanvas(nodeIds: string[], targetCanvasId: string, origin: CanvasPoint): Promise<AppState>;
  renameCanvas(canvasId: string, name: string): Promise<AppState>;
  /** Delete a canvas and all its descendants. Contents are never deleted; they return to history. */
  deleteCanvas(canvasId: string): Promise<AppState>;
  /** Move nodes of one canvas (one gesture = one call). The host snaps to the grid when snapping is on and relocates the moved set to the nearest free spot so it never overlaps another node or card; the returned state holds the final positions. */
  moveNodes(moves: NodeMove[]): Promise<AppState>;
  /** Remove placements and the edges touching them. Contents return to history. */
  removeNodes(nodeIds: string[]): Promise<AppState>;
  /** Rejects self-edges, unknown nodes and duplicates of an existing from→to edge. */
  createEdge(fromNodeId: string, toNodeId: string): Promise<AppState>;
  deleteEdges(edgeIds: string[]): Promise<AppState>;
  /** text/richText only. */
  getContentBody(contentId: string): Promise<ContentBody>;
  /** Save editor output (text/richText only). `html: null` makes the content "text", otherwise "richText". Recomputes the preview and the height of every node showing it. */
  updateTextContent(contentId: string, body: ContentBody): Promise<AppState>;
  /** Store an image inside a text/richText content (paste, drop or pick in the editor). Stored HTML references it as <img data-asset="<contentId>/<assetId>">. */
  addContentAsset(contentId: string, image: ImportImagePayload): Promise<ContentAsset>;
  /** Synchronous URL of a content asset (`asset-thumb` or full pixels) served by the host protocol. */
  assetUrl(contentId: string, assetId: string, variant: "thumb" | "full"): string;
  /** link only; the URL must be absolute http(s). */
  updateLinkContent(contentId: string, url: string): Promise<AppState>;
  /** image only: renames the stored file. */
  renameImage(contentId: string, name: string): Promise<AppState>;
  /** Delete contents everywhere (every placement and edge). Image files go to the recycle bin. */
  deleteContents(contentIds: string[]): Promise<AppState>;
  /** Write contents to the system clipboard in their native formats. */
  copyContents(contentIds: string[]): Promise<{ copied: number }>;
  createCategory(name: string): Promise<AppState>;
  /** Set the category of contents, or clear it with null. Never moves files. */
  classifyContents(contentIds: string[], categoryId: string | null): Promise<AppState>;
  /** Synchronous URL of an image content served by the host `picboard` protocol. */
  imageUrl(contentId: string, variant: "thumb" | "full"): string;
  /** Open an absolute http(s) URL in the system browser. */
  openExternalUrl(url: string): Promise<void>;
  listPlugins(): Promise<PluginListing>;
  startTitlebarDrag(): Promise<void>;
  toggleMaximized(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  closeWindow(): Promise<void>;
  minimizeWindow(): Promise<void>;
  quitApp(): Promise<void>;
  /** Show, un-minimize and focus the main window (hides the tray panel); optionally navigate it. */
  showMainWindow(navigate?: MainNavigation): Promise<void>;
  hideTrayPanel(): Promise<void>;
  getDesktopSettings(): Promise<DesktopSettings>;
  setDesktopSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
  pickDirectory(initialPath?: string): Promise<string | null>;
  /** Main window only: navigation requested from the tray panel ("main:navigate" event). */
  onNavigate(listener: (navigate: MainNavigation) => void): () => void;
}

declare global {
  interface Window {
    imageBoard: ImageBoardApi;
  }
}
