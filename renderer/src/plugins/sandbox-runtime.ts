/**
 * Plugin sandbox runtime. One instance per plugin, inside a dedicated Web
 * Worker (see sandbox-worker.ts).
 *
 * The runtime keeps private references to the worker messaging functions,
 * removes the network and escape APIs from the scope, and then evaluates the
 * plugin's classic script with a single injected binding, `picboard`.
 *
 * Isolation limits: this stops accidental network use and keeps plugin code
 * away from the DOM and Tauri IPC. It is not a strong sandbox against
 * deliberately hostile code, so the app only installs plugins the user trusts.
 */

import {
  PROCESSOR_API_VERSION,
  isRecord,
  validateDescriptor,
  validateRunRequest,
  validateRunResult,
} from "../../../shared/processor-plugin";
import type {
  ProcessorDefinition,
  ProcessorDescriptor,
  ProcessorRunRequest,
  ProcessorRunResult,
} from "../../../shared/processor-plugin";

/** Protocol version carried by every sandbox message. Mirrored in plugin-host.ts. */
export const SANDBOX_PROTOCOL = 1;

export interface SandboxLoadMessage {
  protocol: 1;
  kind: "load";
  code: string;
}

export interface SandboxRunMessage {
  protocol: 1;
  kind: "run";
  requestId: number;
  processorId: string;
  request: ProcessorRunRequest;
}

export interface SandboxCancelMessage {
  protocol: 1;
  kind: "cancel";
  requestId: number;
}

export type SandboxHostMessage = SandboxLoadMessage | SandboxRunMessage | SandboxCancelMessage;

export interface SandboxLoadedMessage {
  protocol: 1;
  kind: "loaded";
  descriptors: ProcessorDescriptor[];
}

export interface SandboxLoadErrorMessage {
  protocol: 1;
  kind: "load-error";
  message: string;
}

export interface SandboxRunResultMessage {
  protocol: 1;
  kind: "run-result";
  requestId: number;
  result: ProcessorRunResult;
}

export interface SandboxRunErrorMessage {
  protocol: 1;
  kind: "run-error";
  requestId: number;
  message: string;
}

export interface SandboxLogMessage {
  protocol: 1;
  kind: "log";
  message: string;
}

export type SandboxWorkerMessage =
  | SandboxLoadedMessage
  | SandboxLoadErrorMessage
  | SandboxRunResultMessage
  | SandboxRunErrorMessage
  | SandboxLogMessage;

/**
 * The slice of the worker global the runtime needs. tsconfig ships DOM libs,
 * not WebWorker, so the worker entry casts `self` to this shape.
 */
export interface SandboxScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/**
 * APIs removed before plugin code runs. They are also passed to the evaluator
 * as parameters bound to undefined, so a bare `fetch` inside plugin code is
 * undefined even if some environment exposes it on a prototype.
 */
const BLOCKED_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "WebTransport",
] as const;

type RegisteredProcessor = {
  descriptor: ProcessorDescriptor;
  run: ProcessorDefinition["run"];
};

function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (typeof caught === "string") return caught;
  return String(caught);
}

function hardenScope(scope: SandboxScope): void {
  const globals = scope as unknown as Record<string, unknown>;
  for (const name of BLOCKED_GLOBALS) {
    try {
      Reflect.deleteProperty(globals, name);
    } catch {
      /* a non-configurable property cannot be removed; shadowing below still wins */
    }
    try {
      Object.defineProperty(globals, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      /* the environment refused the definition; the evaluator parameters still shadow the name */
    }
  }
}

function collectTransferables(result: ProcessorRunResult): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const values of Object.values(result.outputs)) {
    for (const value of values) {
      if (value.type === "image" && value.data.buffer instanceof ArrayBuffer) {
        buffers.add(value.data.buffer);
      }
    }
  }
  return [...buffers];
}

function isHostMessage(value: unknown): value is SandboxHostMessage {
  if (!isRecord(value) || value.protocol !== SANDBOX_PROTOCOL) return false;
  if (value.kind === "load") return typeof value.code === "string";
  if (value.kind === "run") {
    return typeof value.requestId === "number" && typeof value.processorId === "string";
  }
  if (value.kind === "cancel") return typeof value.requestId === "number";
  return false;
}

export function installSandbox(scope: SandboxScope): void {
  // Private references first: hardening must not break the runtime's own
  // messaging, and plugin code must never reach these two functions.
  const post = (message: SandboxWorkerMessage, transfer?: Transferable[]): void => {
    scope.postMessage(message, transfer);
  };
  const listen = scope.addEventListener.bind(scope);

  hardenScope(scope);

  const registered = new Map<string, RegisteredProcessor>();
  const pending = new Map<number, AbortController>();
  let registrationOpen = false;

  const registerProcessor = (definition: unknown): void => {
    if (!registrationOpen) throw new Error("registerProcessor 只能在插件加载期间调用");
    if (!isRecord(definition)) throw new Error("处理器定义必须是对象");
    const checked = validateDescriptor(definition);
    if (!checked.ok) throw new Error(`处理器描述无效：${checked.error}`);
    const run = definition.run;
    if (typeof run !== "function") throw new Error(`处理器 ${checked.value.id} 缺少 run 函数`);
    if (registered.has(checked.value.id)) throw new Error(`处理器 id 重复：${checked.value.id}`);
    registered.set(checked.value.id, {
      descriptor: checked.value,
      run: run as ProcessorDefinition["run"],
    });
  };

  const evaluate = (code: string): void => {
    // A classic script body with one binding: `picboard`. The blocked names are
    // parameters bound to undefined, which shadows them inside the body.
    const factory = new Function(
      "picboard",
      ...BLOCKED_GLOBALS,
      `${code}\n//# sourceURL=picboard-plugin.js`,
    ) as (...args: unknown[]) => unknown;
    factory({ apiVersion: PROCESSOR_API_VERSION, registerProcessor }, ...BLOCKED_GLOBALS.map(() => undefined));
  };

  const handleLoad = (code: string): void => {
    registered.clear();
    registrationOpen = true;
    try {
      evaluate(code);
      post({
        protocol: SANDBOX_PROTOCOL,
        kind: "loaded",
        descriptors: [...registered.values()].map((entry) => entry.descriptor),
      });
    } catch (caught) {
      registered.clear();
      post({ protocol: SANDBOX_PROTOCOL, kind: "load-error", message: errorMessage(caught) });
    } finally {
      registrationOpen = false;
    }
  };

  const runProcessor = (message: SandboxRunMessage): void => {
    const entry = registered.get(message.processorId);
    if (!entry) {
      post({
        protocol: SANDBOX_PROTOCOL,
        kind: "run-error",
        requestId: message.requestId,
        message: `未注册的处理器：${message.processorId}`,
      });
      return;
    }
    const request = validateRunRequest(entry.descriptor, message.request);
    if (!request.ok) {
      post({
        protocol: SANDBOX_PROTOCOL,
        kind: "run-error",
        requestId: message.requestId,
        message: `运行请求无效：${request.error}`,
      });
      return;
    }

    const controller = new AbortController();
    pending.set(message.requestId, controller);
    const context = {
      signal: controller.signal,
      log: (text: string): void => {
        post({ protocol: SANDBOX_PROTOCOL, kind: "log", message: String(text) });
      },
    };

    void (async () => {
      try {
        const result = await entry.run(request.value, context);
        if (!pending.has(message.requestId)) return;
        pending.delete(message.requestId);
        const checked = validateRunResult(entry.descriptor, result);
        if (!checked.ok) {
          post({
            protocol: SANDBOX_PROTOCOL,
            kind: "run-error",
            requestId: message.requestId,
            message: `运行结果无效：${checked.error}`,
          });
          return;
        }
        post(
          {
            protocol: SANDBOX_PROTOCOL,
            kind: "run-result",
            requestId: message.requestId,
            result: checked.value,
          },
          collectTransferables(checked.value),
        );
      } catch (caught) {
        if (!pending.has(message.requestId)) return;
        pending.delete(message.requestId);
        post({
          protocol: SANDBOX_PROTOCOL,
          kind: "run-error",
          requestId: message.requestId,
          message: errorMessage(caught),
        });
      }
    })();
  };

  const cancelRun = (requestId: number): void => {
    const controller = pending.get(requestId);
    if (!controller) return;
    pending.delete(requestId);
    controller.abort();
  };

  listen("message", (event) => {
    const message = event.data;
    if (!isHostMessage(message)) return;
    if (message.kind === "load") {
      handleLoad(message.code);
      return;
    }
    if (message.kind === "run") {
      runProcessor(message);
      return;
    }
    cancelRun(message.requestId);
  });
}
