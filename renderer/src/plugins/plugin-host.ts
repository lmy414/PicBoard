/**
 * Main-thread plugin host: owns one worker per plugin, validates everything
 * that crosses the worker boundary, and exposes the processors the future
 * "run" action will call. Nothing in the app runs a processor in this phase.
 */

import type { PluginSource } from "../../../shared/image-board";
import {
  isRecord,
  splitProcessorId,
  validateDescriptor,
  validateManifest,
  validateRunRequest,
  validateRunResult,
} from "../../../shared/processor-plugin";
import type {
  PluginManifest,
  ProcessorDescriptor,
  ProcessorRunRequest,
  ProcessorRunResult,
} from "../../../shared/processor-plugin";

/** Protocol version carried by every sandbox message. Mirrored in sandbox-runtime.ts. */
const PROTOCOL = 1;

export interface WorkerEvent {
  data?: unknown;
  message?: string;
  error?: unknown;
}

/** The slice of Worker the host needs; tests inject an in-process implementation. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error", listener: (event: WorkerEvent) => void): void;
  terminate(): void;
}

export interface PluginHostOptions {
  createWorker?: () => WorkerLike;
  /** Milliseconds to wait for `loaded` after sending plugin code. Defaults to 5000. */
  loadTimeoutMs?: number;
  /** Default milliseconds for one run. Defaults to 30000. */
  runTimeoutMs?: number;
}

export interface PluginStatus {
  folder: string;
  manifest?: PluginManifest;
  status: "ready" | "error";
  error?: string;
  processors: ProcessorDescriptor[];
}

export interface PluginRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PluginHost {
  /** Replaces every previously loaded plugin. Statuses keep the source order. */
  load(sources: PluginSource[]): Promise<PluginStatus[]>;
  list(): PluginStatus[];
  getProcessor(fullId: string): ProcessorDescriptor | undefined;
  run(
    fullId: string,
    request: ProcessorRunRequest,
    options?: PluginRunOptions,
  ): Promise<ProcessorRunResult>;
  dispose(): void;
}

interface PendingRun {
  descriptor: ProcessorDescriptor;
  resolve: (result: ProcessorRunResult) => void;
  reject: (error: Error) => void;
  clearTimer: () => void;
  detach: () => void;
}

interface LoadWaiter {
  resolve: (descriptors: unknown[]) => void;
  reject: (message: string) => void;
}

interface PluginEntry {
  status: PluginStatus;
  worker: WorkerLike | null;
  pending: Map<number, PendingRun>;
  loadWaiter: LoadWaiter | null;
}

type LoadOutcome = { descriptors: unknown[] } | { error: string };

function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  return String(caught);
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("运行已取消", "AbortError");
  const error = new Error("运行已取消");
  error.name = "AbortError";
  return error;
}

function defaultCreateWorker(): WorkerLike {
  const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), { type: "module" });
  return worker as unknown as WorkerLike;
}

function errorEntry(folder: string, message: string, manifest?: PluginManifest): PluginEntry {
  return {
    status: { folder, manifest, status: "error", error: message, processors: [] },
    worker: null,
    pending: new Map(),
    loadWaiter: null,
  };
}

export function createPluginHost(options: PluginHostOptions = {}): PluginHost {
  const createWorker = options.createWorker ?? defaultCreateWorker;
  const loadTimeoutMs = options.loadTimeoutMs ?? 5000;
  const runTimeoutMs = options.runTimeoutMs ?? 30000;
  let entries: PluginEntry[] = [];
  let nextRequestId = 1;

  const list = (): PluginStatus[] =>
    entries.map((entry) => ({ ...entry.status, processors: [...entry.status.processors] }));

  const stopWorker = (entry: PluginEntry): void => {
    const worker = entry.worker;
    entry.worker = null;
    worker?.terminate();
  };

  const rejectPending = (entry: PluginEntry, message: string): void => {
    for (const pending of entry.pending.values()) {
      pending.clearTimer();
      pending.detach();
      pending.reject(new Error(message));
    }
    entry.pending.clear();
  };

  const failPlugin = (entry: PluginEntry, message: string): void => {
    entry.status = { ...entry.status, status: "error", error: message };
    stopWorker(entry);
    rejectPending(entry, message);
  };

  const handleWorkerError = (entry: PluginEntry, event: WorkerEvent): void => {
    const message = typeof event.message === "string" && event.message !== ""
      ? `插件 Worker 崩溃：${event.message}`
      : "插件 Worker 崩溃";
    const waiter = entry.loadWaiter;
    entry.loadWaiter = null;
    waiter?.reject(message);
    failPlugin(entry, message);
  };

  const handleMessage = (entry: PluginEntry, data: unknown): void => {
    if (!isRecord(data) || data.protocol !== PROTOCOL) return;
    const kind = data.kind;

    if (kind === "loaded") {
      const waiter = entry.loadWaiter;
      entry.loadWaiter = null;
      if (!Array.isArray(data.descriptors)) {
        waiter?.reject("插件加载结果无效");
        return;
      }
      waiter?.resolve(data.descriptors);
      return;
    }

    if (kind === "load-error") {
      const waiter = entry.loadWaiter;
      entry.loadWaiter = null;
      waiter?.reject(typeof data.message === "string" ? data.message : "插件加载失败");
      return;
    }

    if (kind === "log") {
      console.debug(`[plugin ${entry.status.folder}] ${String(data.message)}`);
      return;
    }

    const requestId = data.requestId;
    if (typeof requestId !== "number") return;
    const pending = entry.pending.get(requestId);
    if (!pending) return;

    if (kind === "run-result") {
      entry.pending.delete(requestId);
      pending.clearTimer();
      pending.detach();
      const checked = validateRunResult(pending.descriptor, data.result);
      if (checked.ok) pending.resolve(checked.value);
      else pending.reject(new Error(`运行结果无效：${checked.error}`));
      return;
    }

    if (kind === "run-error") {
      entry.pending.delete(requestId);
      pending.clearTimer();
      pending.detach();
      pending.reject(new Error(typeof data.message === "string" ? data.message : "处理器运行失败"));
    }
  };

  const attachWorker = (entry: PluginEntry, worker: WorkerLike): void => {
    worker.addEventListener("message", (event) => handleMessage(entry, event.data));
    worker.addEventListener("error", (event) => handleWorkerError(entry, event));
  };

  const awaitLoad = (entry: PluginEntry, worker: WorkerLike, code: string): Promise<LoadOutcome> => {
    const { promise, resolve } = Promise.withResolvers<LoadOutcome>();
    const timer = setTimeout(() => {
      entry.loadWaiter = null;
      resolve({ error: "加载插件超时" });
    }, loadTimeoutMs);
    entry.loadWaiter = {
      resolve: (descriptors) => {
        clearTimeout(timer);
        resolve({ descriptors });
      },
      reject: (message) => {
        clearTimeout(timer);
        resolve({ error: message });
      },
    };
    try {
      worker.postMessage({ protocol: PROTOCOL, kind: "load", code });
    } catch (caught) {
      entry.loadWaiter = null;
      clearTimeout(timer);
      resolve({ error: `无法向 Worker 发送插件代码：${errorMessage(caught)}` });
    }
    return promise;
  };

  const startPlugin = async (entry: PluginEntry, source: PluginSource): Promise<void> => {
    let worker: WorkerLike;
    try {
      worker = createWorker();
    } catch (caught) {
      entry.status = { ...entry.status, status: "error", error: `无法创建 Worker：${errorMessage(caught)}` };
      return;
    }
    entry.worker = worker;
    attachWorker(entry, worker);

    const outcome = await awaitLoad(entry, worker, source.code);
    if ("error" in outcome) {
      entry.status = { ...entry.status, status: "error", error: outcome.error };
      stopWorker(entry);
      return;
    }

    const processors: ProcessorDescriptor[] = [];
    const ids = new Set<string>();
    for (const raw of outcome.descriptors) {
      const checked = validateDescriptor(raw);
      if (!checked.ok) {
        entry.status = { ...entry.status, status: "error", error: `处理器描述无效：${checked.error}` };
        stopWorker(entry);
        return;
      }
      if (ids.has(checked.value.id)) {
        entry.status = { ...entry.status, status: "error", error: `处理器 id 重复：${checked.value.id}` };
        stopWorker(entry);
        return;
      }
      ids.add(checked.value.id);
      processors.push(checked.value);
    }

    entry.status = {
      folder: entry.status.folder,
      manifest: entry.status.manifest,
      status: "ready",
      processors,
    };
  };

  const load = async (sources: PluginSource[]): Promise<PluginStatus[]> => {
    dispose();
    const seen = new Set<string>();
    const started: Array<{ entry: PluginEntry; source: PluginSource }> = [];
    for (const source of sources) {
      const checked = validateManifest(source.manifest);
      if (!checked.ok) {
        entries.push(errorEntry(source.folder, `清单无效：${checked.error}`));
        continue;
      }
      const manifest = checked.value;
      if (seen.has(manifest.id)) {
        entries.push(errorEntry(source.folder, `插件 id 重复：${manifest.id}`, manifest));
        continue;
      }
      seen.add(manifest.id);
      const entry: PluginEntry = {
        status: { folder: source.folder, manifest, status: "error", processors: [] },
        worker: null,
        pending: new Map(),
        loadWaiter: null,
      };
      entries.push(entry);
      started.push({ entry, source });
    }
    await Promise.all(started.map(({ entry, source }) => startPlugin(entry, source)));
    return list();
  };

  const getProcessor = (fullId: string): ProcessorDescriptor | undefined => {
    const parts = splitProcessorId(fullId);
    if (!parts) return undefined;
    const entry = entries.find(
      (candidate) => candidate.status.status === "ready" && candidate.status.manifest?.id === parts.pluginId,
    );
    return entry?.status.processors.find((processor) => processor.id === parts.processorId);
  };

  const run = (
    fullId: string,
    request: ProcessorRunRequest,
    runOptions: PluginRunOptions = {},
  ): Promise<ProcessorRunResult> => {
    const parts = splitProcessorId(fullId);
    if (!parts) return Promise.reject(new Error(`处理器 id 无效：${fullId}`));
    const entry = entries.find((candidate) => candidate.status.manifest?.id === parts.pluginId);
    if (!entry || !entry.worker || entry.status.status !== "ready") {
      return Promise.reject(new Error(`插件不可用：${parts.pluginId}`));
    }
    const descriptor = entry.status.processors.find((processor) => processor.id === parts.processorId);
    if (!descriptor) return Promise.reject(new Error(`未找到处理器：${fullId}`));
    const checked = validateRunRequest(descriptor, request);
    if (!checked.ok) return Promise.reject(new Error(`运行请求无效：${checked.error}`));

    const signal = runOptions.signal;
    if (signal?.aborted) return Promise.reject(abortError());

    const worker = entry.worker;
    const requestId = nextRequestId++;
    const timeoutMs = runOptions.timeoutMs ?? runTimeoutMs;
    const { promise, resolve, reject } = Promise.withResolvers<ProcessorRunResult>();
    let settled = false;
    let clearTimer = (): void => {};

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      entry.pending.delete(requestId);
      return true;
    };
    const detach = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const cancelOnWorker = (): void => {
      try {
        worker.postMessage({ protocol: PROTOCOL, kind: "cancel", requestId });
      } catch {
        /* the worker may already be gone */
      }
    };
    function onAbort(): void {
      if (!settle()) return;
      clearTimer();
      detach();
      cancelOnWorker();
      reject(abortError());
    }

    const timer = setTimeout(() => {
      if (!settle()) return;
      detach();
      cancelOnWorker();
      failPlugin(entry, "运行超时");
      reject(new Error("运行超时"));
    }, timeoutMs);
    clearTimer = () => clearTimeout(timer);

    entry.pending.set(requestId, { descriptor, resolve, reject, clearTimer, detach });
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      worker.postMessage({
        protocol: PROTOCOL,
        kind: "run",
        requestId,
        processorId: parts.processorId,
        request: checked.value,
      });
    } catch (caught) {
      if (settle()) {
        clearTimer();
        detach();
        reject(new Error(`无法向 Worker 发送运行请求：${errorMessage(caught)}`));
      }
    }
    return promise;
  };

  const dispose = (): void => {
    for (const entry of entries) {
      const waiter = entry.loadWaiter;
      entry.loadWaiter = null;
      waiter?.reject("插件宿主已关闭");
      rejectPending(entry, "插件宿主已关闭");
      stopWorker(entry);
    }
    entries = [];
  };

  return { load, list, getProcessor, run, dispose };
}

let sharedHost: PluginHost | null = null;

/** App-wide host. Settings uses it to load plugins; a later phase runs processors through it. */
export function getPluginHost(): PluginHost {
  sharedHost ??= createPluginHost();
  return sharedHost;
}
