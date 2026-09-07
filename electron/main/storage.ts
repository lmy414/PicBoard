import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppState,
  CanvasRecord,
  CanvasViewport,
  CategoryRecord,
  ImageRecord,
  ImportImagePayload,
  ImportViewport,
} from "../shared";

type PersistedImage = Omit<ImageRecord, "dataUrl">;
type PersistedState = Omit<AppState, "images" | "storageNotice"> & {
  images: Record<string, PersistedImage>;
};

export interface ClipboardLike {
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
  writeBuffer(format: string, buffer: Buffer, type?: "selection" | "clipboard"): void;
  writeText(text: string, type?: "selection" | "clipboard"): void;
}

export type FileClipboardWriter = (filePaths: string[]) => void | Promise<void>;

export interface StorageOptions {
  rootDir: string;
  clipboard?: ClipboardLike;
  fileClipboard?: FileClipboardWriter;
  now?: () => string;
  uuid?: () => string;
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: -900, y: -500, zoom: 1 };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;

function cloneState(value: AppState): AppState {
  return {
    ...value,
    canvases: value.canvases.map((canvas) => ({ ...canvas, imageIds: [...canvas.imageIds], viewport: { ...canvas.viewport } })),
    categories: value.categories.map((category) => ({ ...category })),
    images: Object.fromEntries(Object.entries(value.images).map(([id, image]) => [id, { ...image }])),
  };
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeViewport(value: unknown): CanvasViewport {
  const candidate = value && typeof value === "object" ? value as Partial<CanvasViewport> : {};
  return {
    x: Math.round(finiteNumber(candidate.x, DEFAULT_VIEWPORT.x)),
    y: Math.round(finiteNumber(candidate.y, DEFAULT_VIEWPORT.y)),
    zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, finiteNumber(candidate.zoom, DEFAULT_VIEWPORT.zoom))),
  };
}

function normalizeState(value: unknown): AppState {
  if (!value || typeof value !== "object") throw new Error("本地状态不是有效对象");
  const candidate = value as Partial<AppState>;
  if (!Array.isArray(candidate.canvases) || !Array.isArray(candidate.categories) || !candidate.images || typeof candidate.images !== "object") throw new Error("本地状态结构不完整");
  const canvases = candidate.canvases.map((canvas) => {
    if (!canvas || typeof canvas !== "object" || typeof canvas.id !== "string" || typeof canvas.name !== "string" || !Array.isArray(canvas.imageIds)) throw new Error("本地状态包含无效画布");
    return { id: canvas.id, name: canvas.name, imageIds: canvas.imageIds.filter((id): id is string => typeof id === "string"), createdAt: typeof canvas.createdAt === "string" ? canvas.createdAt : new Date(0).toISOString(), viewport: normalizeViewport(canvas.viewport) } satisfies CanvasRecord;
  });
  if (canvases.length === 0 || typeof candidate.activeCanvasId !== "string" || !canvases.some((canvas) => canvas.id === candidate.activeCanvasId)) throw new Error("本地状态没有有效的当前画布");
  const categories = candidate.categories.map((category) => {
    if (!category || typeof category !== "object" || typeof category.id !== "string" || typeof category.name !== "string") throw new Error("本地状态包含无效分类");
    return { id: category.id, name: category.name, createdAt: typeof category.createdAt === "string" ? category.createdAt : new Date(0).toISOString() } satisfies CategoryRecord;
  });
  const images: Record<string, ImageRecord> = {};
  for (const [id, image] of Object.entries(candidate.images as Record<string, Partial<ImageRecord>>)) {
    if (!image || typeof image !== "object" || typeof image.id !== "string" || image.id !== id || typeof image.fileName !== "string" || typeof image.relativePath !== "string") throw new Error("本地状态包含无效图片记录");
    images[id] = { id: image.id, fileName: image.fileName, relativePath: image.relativePath, status: image.status === "classified" ? "classified" : "pending", categoryId: typeof image.categoryId === "string" ? image.categoryId : null, canvasId: typeof image.canvasId === "string" ? image.canvasId : null, x: Math.round(finiteNumber(image.x, 0)), y: Math.round(finiteNumber(image.y, 0)), width: Math.max(1, Math.round(finiteNumber(image.width, 160))), height: Math.max(1, Math.round(finiteNumber(image.height, 140))), createdAt: typeof image.createdAt === "string" ? image.createdAt : new Date(0).toISOString() };
  }
  return { activeCanvasId: candidate.activeCanvasId, canvases, categories, images };
}

function withoutPreview(value: AppState): PersistedState {
  const images: Record<string, PersistedImage> = {};
  for (const [id, image] of Object.entries(value.images)) {
    const { dataUrl: _dataUrl, ...persisted } = image;
    images[id] = persisted;
  }
  const { storageNotice: _storageNotice, ...persistedState } = value;
  return { ...persistedState, images };
}

/** A real Windows CF_HDROP payload: DROPFILES header + double-NUL UTF-16LE path list. */
export function buildWindowsFileDropBuffer(filePaths: string[]): Buffer {
  const paths = filePaths.map((filePath) => filePath.replaceAll("/", "\\"));
  const fileList = Buffer.from(`${paths.join("\0")}\0\0`, "utf16le");
  const dropFiles = Buffer.alloc(20);
  dropFiles.writeUInt32LE(20, 0);
  dropFiles.writeInt32LE(0, 4);
  dropFiles.writeInt32LE(0, 8);
  dropFiles.writeUInt32LE(0, 12);
  dropFiles.writeUInt32LE(1, 16);
  return Buffer.concat([dropFiles, fileList]);
}

export class ImageBoardStorage {
  private readonly root: string;
  private readonly clipboard?: ClipboardLike;
  private readonly fileClipboard?: FileClipboardWriter;
  private readonly getNow: () => string;
  private readonly getUuid: () => string;
  private readonly stateFile: string;
  private readonly backupFile: string;
  private readonly pending: string;
  private readonly classified: string;
  private readonly trash: string;
  private state: AppState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private preserveBackup = false;
  private previewsLoaded = false;

  constructor(options: StorageOptions) {
    this.root = options.rootDir;
    this.clipboard = options.clipboard;
    this.fileClipboard = options.fileClipboard;
    this.getNow = options.now ?? (() => new Date().toISOString());
    this.getUuid = options.uuid ?? randomUUID;
    this.stateFile = path.join(this.root, "state.json");
    this.backupFile = path.join(this.root, "state.json.bak");
    this.pending = path.join(this.root, "pending");
    this.classified = path.join(this.root, "classified");
    this.trash = path.join(this.root, ".trash");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureDirectories() {
    await fs.mkdir(this.pending, { recursive: true });
    await fs.mkdir(this.classified, { recursive: true });
    await fs.mkdir(this.trash, { recursive: true });
  }

  private createCanvas(name: string): CanvasRecord { return { id: this.getUuid(), name, imageIds: [], createdAt: this.getNow(), viewport: { ...DEFAULT_VIEWPORT } }; }
  private createCategory(name: string): CategoryRecord { return { id: this.getUuid(), name, createdAt: this.getNow() }; }
  private defaultState(): AppState {
    const firstCanvas = this.createCanvas("画布 1");
    return { activeCanvasId: firstCanvas.id, canvases: [firstCanvas], categories: [this.createCategory("角色"), this.createCategory("其他")], images: {} };
  }

  private async hydrate(value: AppState): Promise<AppState> {
    const result = cloneState(value);
    await Promise.all(Object.values(result.images).map(async (image) => {
      try {
        const data = await fs.readFile(path.join(this.root, image.relativePath));
        image.dataUrl = `data:${this.mimeFor(image.fileName)};base64,${data.toString("base64")}`;
      } catch { image.dataUrl = undefined; }
    }));
    return result;
  }

  private mimeFor(fileName: string) {
    const extension = path.extname(fileName).toLowerCase();
    return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" } as Record<string, string>)[extension] ?? "application/octet-stream";
  }

  private async loadInternal(): Promise<AppState> {
    await this.ensureDirectories();
    if (this.state) return this.state;
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.stateFile, "utf8")));
      return this.state;
    } catch (error) {
      const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
      if (!missing) {
        const corruptCopy = `${this.stateFile}.corrupt-${Date.now()}`;
        try { await fs.copyFile(this.stateFile, corruptCopy); } catch { /* preserve the original when possible */ }
        try {
          this.state = normalizeState(JSON.parse(await fs.readFile(this.backupFile, "utf8")));
          this.state.storageNotice = "state.json 损坏，已使用备份恢复；损坏原文件已保留。";
          this.preserveBackup = true;
          await this.writeInternal();
          return this.state;
        } catch { throw new Error(`本地状态损坏，原文件已保留（${corruptCopy}）。请先备份后再处理。`); }
      }
      this.state = this.defaultState();
      await this.writeInternal();
      return this.state;
    }
  }

  private async writeInternal() {
    if (!this.state) return;
    await this.ensureDirectories();
    const temporary = `${this.stateFile}.tmp-${this.getUuid()}`;
    const content = JSON.stringify(withoutPreview(this.state), null, 2);
    let handle;
    try {
      handle = await fs.open(temporary, "wx");
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (!this.preserveBackup) {
        try { await fs.copyFile(this.stateFile, this.backupFile); } catch (error) {
          const missing = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
          if (!missing) throw error;
        }
      }
      try { await fs.rename(temporary, this.stateFile); } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
        if (process.platform !== "win32" || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
        await fs.rm(this.stateFile, { force: true });
        await fs.rename(temporary, this.stateFile);
      }
      this.preserveBackup = false;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private requireState() { if (!this.state) throw new Error("本地状态尚未加载"); return this.state; }
  private requireCanvas(canvasId: string) { const canvas = this.requireState().canvases.find((item) => item.id === canvasId); if (!canvas) throw new Error("找不到指定画布"); return canvas; }
  private requireImage(imageId: string) { const image = this.requireState().images[imageId]; if (!image) throw new Error("找不到指定图片"); return image; }
  private safeSegment(value: string) { return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "其他"; }
  private uniqueName(name: string, id: string) { return `${id}${path.extname(name).toLowerCase() || ".png"}`; }

  private async transact<T>(operation: (before: AppState) => Promise<T>): Promise<T> {
    await this.loadInternal();
    if (!this.previewsLoaded) {
      this.state = await this.hydrate(this.requireState());
      this.previewsLoaded = true;
    }
    const before = cloneState(this.requireState());
    try { return await operation(before); } catch (error) { this.state = before; throw error; }
  }

  async loadState() {
    return this.enqueue(async () => {
      this.state = await this.hydrate(await this.loadInternal());
      this.previewsLoaded = true;
      return cloneState(this.state);
    });
  }

  async importImages(canvasId: string, payloads: ImportImagePayload[], viewport?: ImportViewport) {
    return this.enqueue(async () => this.transact(async (before) => {
      const canvas = this.requireCanvas(canvasId);
      const view = viewport ? normalizeViewport(viewport) : canvas.viewport;
      canvas.viewport = view;
      const viewWidth = Math.max(320, finiteNumber(viewport?.width, 640));
      const viewHeight = Math.max(240, finiteNumber(viewport?.height, 480));
      const startX = (viewWidth / 2 - view.x) / view.zoom - 80;
      const startY = (viewHeight / 2 - view.y) / view.zoom - 70;
      const createdFiles: string[] = [];
      try {
        for (const [index, payload] of payloads.entries()) {
          const id = this.getUuid();
          const fileName = payload.name || `${id}.png`;
          const relativePath = path.join("pending", this.uniqueName(fileName, id));
          const absolutePath = path.join(this.root, relativePath);
          await fs.writeFile(absolutePath, Buffer.from(payload.data), { flag: "wx" });
          createdFiles.push(absolutePath);
          this.requireState().images[id] = { id, fileName, relativePath, status: "pending", categoryId: null, canvasId, x: Math.round(startX + (index % 3) * 190), y: Math.round(startY + Math.floor(index / 3) * 180), width: 160, height: 140, createdAt: this.getNow() };
          canvas.imageIds.push(id);
        }
        await this.writeInternal();
      } catch (error) {
        this.state = before;
        await Promise.all(createdFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
        throw error;
      }
      this.state = await this.hydrate(this.requireState());
      this.previewsLoaded = true;
      return cloneState(this.state);
    }));
  }

  async pasteImage(canvasId: string) {
    return this.enqueue(async () => {
      await this.loadInternal();
      if (!this.clipboard) return { state: await this.hydrate(this.requireState()), imported: false };
      const image = this.clipboard.readImage();
      if (image.isEmpty()) return { state: await this.hydrate(this.requireState()), imported: false };
      return { state: await this.importImagesInternal(this.requireCanvas(canvasId), [{ name: `粘贴图片-${Date.now()}.png`, data: image.toPNG() }]), imported: true };
    });
  }

  private async importImagesInternal(canvas: CanvasRecord, payloads: ImportImagePayload[]) {
    const startX = (640 / 2 - canvas.viewport.x) / canvas.viewport.zoom - 80;
    const startY = (480 / 2 - canvas.viewport.y) / canvas.viewport.zoom - 70;
    const before = cloneState(this.requireState());
    const createdFiles: string[] = [];
    try {
      for (const [index, payload] of payloads.entries()) {
        const id = this.getUuid();
        const fileName = payload.name || `${id}.png`;
        const relativePath = path.join("pending", this.uniqueName(fileName, id));
        const absolutePath = path.join(this.root, relativePath);
        await fs.writeFile(absolutePath, Buffer.from(payload.data), { flag: "wx" });
        createdFiles.push(absolutePath);
        this.requireState().images[id] = { id, fileName, relativePath, status: "pending", categoryId: null, canvasId: canvas.id, x: Math.round(startX + (index % 3) * 190), y: Math.round(startY + Math.floor(index / 3) * 180), width: 160, height: 140, createdAt: this.getNow() };
        canvas.imageIds.push(id);
      }
      await this.writeInternal();
      this.state = await this.hydrate(this.requireState());
      this.previewsLoaded = true;
      return cloneState(this.state);
    } catch (error) {
      this.state = before;
      await Promise.all(createdFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
      throw error;
    }
  }

  async setActiveCanvas(canvasId: string) { return this.enqueue(async () => this.transact(async () => { this.requireCanvas(canvasId); this.requireState().activeCanvasId = canvasId; await this.writeInternal(); return cloneState(this.requireState()); })); }
  async setCanvasViewport(canvasId: string, viewport: CanvasViewport) { return this.enqueue(async () => this.transact(async () => { this.requireCanvas(canvasId).viewport = normalizeViewport(viewport); await this.writeInternal(); return cloneState(this.requireState()); })); }

  async createCanvasRecord() { return this.enqueue(async () => this.transact(async () => { const canvas = this.createCanvas(`画布 ${this.requireState().canvases.length + 1}`); this.requireState().canvases.push(canvas); this.requireState().activeCanvasId = canvas.id; await this.writeInternal(); return cloneState(this.requireState()); })); }
  async renameCanvas(canvasId: string, name: string) { return this.enqueue(async () => this.transact(async () => { const canvas = this.requireCanvas(canvasId); canvas.name = name.trim() || canvas.name; await this.writeInternal(); return cloneState(this.requireState()); })); }

  async deleteCanvas(canvasId: string) {
    return this.enqueue(async () => this.transact(async (before) => {
      const state = this.requireState();
      const canvas = this.requireCanvas(canvasId);
      const movedToTrash: Array<{ from: string; to: string }> = [];
      try {
        for (const imageId of canvas.imageIds) {
          const image = state.images[imageId];
          if (!image) continue;
          if (image.status === "pending") {
            const from = path.join(this.root, image.relativePath);
            const to = path.join(this.trash, `${image.id}-${this.getUuid()}`);
            await fs.rename(from, to);
            movedToTrash.push({ from, to });
            delete state.images[imageId];
          } else image.canvasId = null;
        }
        state.canvases = state.canvases.filter((item) => item.id !== canvasId);
        if (state.canvases.length === 0) state.canvases.push(this.createCanvas("画布 1"));
        if (state.activeCanvasId === canvasId) state.activeCanvasId = state.canvases[0].id;
        await this.writeInternal();
      } catch (error) {
        this.state = before;
        await Promise.all(movedToTrash.map(({ from, to }) => fs.rename(to, from).catch(() => undefined)));
        throw error;
      }
      await Promise.all(movedToTrash.map(({ to }) => fs.rm(to, { force: true }).catch(() => undefined)));
      return cloneState(state);
    }));
  }

  async createCategoryRecord(name: string) { return this.enqueue(async () => this.transact(async () => { const normalized = name.trim(); if (normalized && !this.requireState().categories.some((category) => category.name === normalized)) { this.requireState().categories.push(this.createCategory(normalized)); await this.writeInternal(); } return cloneState(this.requireState()); })); }

  async classifyImages(imageIds: string[], categoryId: string) {
    return this.enqueue(async () => this.transact(async (before) => {
      const state = this.requireState();
      const category = state.categories.find((item) => item.id === categoryId);
      if (!category) throw new Error("找不到指定分类");
      const moved: Array<{ from: string; to: string }> = [];
      try {
        for (const imageId of imageIds) {
          const image = this.requireImage(imageId);
          const nextRelativePath = path.join("classified", this.safeSegment(category.id), this.uniqueName(image.fileName, image.id));
          const nextAbsolutePath = path.join(this.root, nextRelativePath);
          if (image.status !== "classified" || image.categoryId !== categoryId || image.relativePath !== nextRelativePath) {
            await fs.mkdir(path.dirname(nextAbsolutePath), { recursive: true });
            const from = path.join(this.root, image.relativePath);
            await fs.rename(from, nextAbsolutePath);
            moved.push({ from, to: nextAbsolutePath });
            image.relativePath = nextRelativePath;
            image.status = "classified";
          }
          image.categoryId = categoryId;
        }
        await this.writeInternal();
      } catch (error) {
        this.state = before;
        await Promise.all(moved.map(({ from, to }) => fs.rename(to, from).catch(() => undefined)));
        throw error;
      }
      return cloneState(state);
    }));
  }

  async removeImageFromCanvas(imageId: string) {
    return this.enqueue(async () => this.transact(async (before) => {
      const state = this.requireState();
      const image = this.requireImage(imageId);
      if (!image.canvasId) return cloneState(state);
      const canvas = this.requireCanvas(image.canvasId);
      canvas.imageIds = canvas.imageIds.filter((id) => id !== imageId);
      image.canvasId = null;
      let moved: { from: string; to: string } | undefined;
      try {
        if (image.status === "pending") {
          const from = path.join(this.root, image.relativePath);
          const to = path.join(this.trash, `${image.id}-${this.getUuid()}`);
          await fs.rename(from, to);
          moved = { from, to };
          delete state.images[imageId];
        }
        await this.writeInternal();
      } catch (error) {
        this.state = before;
        if (moved) await fs.rename(moved.to, moved.from).catch(() => undefined);
        throw error;
      }
      if (moved) await fs.rm(moved.to, { force: true }).catch(() => undefined);
      return cloneState(state);
    }));
  }

  async moveImage(imageId: string, x: number, y: number) { return this.enqueue(async () => this.transact(async () => { const image = this.requireImage(imageId); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("图片坐标无效"); image.x = Math.round(x); image.y = Math.round(y); await this.writeInternal(); return cloneState(this.requireState()); })); }

  async copyImageFiles(imageIds: string[]) {
    return this.enqueue(async () => {
      await this.loadInternal();
      const paths = [...new Set(imageIds)].map((imageId) => path.join(this.root, this.requireImage(imageId).relativePath));
      if (paths.length === 0) return { copied: 0 };
      await Promise.all(paths.map((filePath) => fs.access(filePath)));
      if (process.platform === "win32") {
        if (!this.fileClipboard) throw new Error("Windows 文件剪贴板不可用");
        await this.fileClipboard(paths);
      } else {
        if (!this.clipboard) throw new Error("系统剪贴板不可用");
        this.clipboard.writeText(paths.join("\n"), "clipboard");
      }
      return { copied: paths.length };
    });
  }

}

export function createStorage(options: StorageOptions) { return new ImageBoardStorage(options); }
