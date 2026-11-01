// Plugin host tests (lane P). The real sandbox runtime runs in-process: the
// injected WorkerLike wires two MessagePorts together and installs the runtime
// on a fake scope, so no browser Worker is needed.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { installSandbox } from "../renderer/src/plugins/sandbox-runtime";
import type { SandboxScope } from "../renderer/src/plugins/sandbox-runtime";
import { createPluginHost } from "../renderer/src/plugins/plugin-host";
import type { WorkerEvent, WorkerLike } from "../renderer/src/plugins/plugin-host";
import { portAccepts, validateRunRequest } from "../shared/processor-plugin";
import type { ProcessorRunRequest } from "../shared/processor-plugin";
import type { PluginSource } from "../shared/image-board";

const FIXTURE = new URL("./fixtures/plugins/example-uppercase/", import.meta.url);

function fixtureSource(): PluginSource {
  return {
    folder: "example-uppercase",
    manifest: JSON.parse(readFileSync(new URL("manifest.json", FIXTURE), "utf8")) as unknown,
    code: readFileSync(new URL("main.js", FIXTURE), "utf8"),
  };
}

function plugin(folder: string, manifest: Record<string, unknown>, code: string): PluginSource {
  return { folder, manifest, code };
}

function manifestFor(id: string): Record<string, unknown> {
  return { apiVersion: 1, id, name: id, version: "1.0.0" };
}

function createFakeWorker(): { worker: WorkerLike; scope: SandboxScope } {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const sandboxPort = channel.port2;

  const scope: SandboxScope = {
    postMessage: (message, transfer) => sandboxPort.postMessage(message, transfer ?? []),
    addEventListener: (type, listener) => {
      sandboxPort.addEventListener(type, (event) => listener({ data: event.data }));
    },
  };
  installSandbox(scope);
  sandboxPort.start();

  const messageListeners: Array<(event: WorkerEvent) => void> = [];
  hostPort.addEventListener("message", (event) => {
    for (const listener of messageListeners) listener({ data: event.data });
  });
  hostPort.start();

  return {
    scope,
    worker: {
      postMessage: (message, transfer) => hostPort.postMessage(message, transfer ?? []),
      addEventListener: (type, listener) => {
        if (type === "message") messageListeners.push(listener);
      },
      terminate: () => {
        hostPort.close();
        sandboxPort.close();
      },
    },
  };
}

function createHost(options: {
  onScope?: (scope: SandboxScope) => void;
  loadTimeoutMs?: number;
  runTimeoutMs?: number;
} = {}) {
  return createPluginHost({
    loadTimeoutMs: options.loadTimeoutMs ?? 1000,
    runTimeoutMs: options.runTimeoutMs ?? 200,
    createWorker: () => {
      const fake = createFakeWorker();
      options.onScope?.(fake.scope);
      return fake.worker;
    },
  });
}

test("loads the example plugin and registers a validated descriptor", async () => {
  const host = createHost();
  try {
    const statuses = await host.load([fixtureSource()]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("ready");
    expect(statuses[0].processors.map((processor) => processor.id)).toEqual(["uppercase"]);

    const descriptor = host.getProcessor("example-uppercase/uppercase");
    expect(descriptor?.title).toBe("转为大写");
    expect(descriptor?.inputs[0]).toMatchObject({ id: "text", type: "text" });
    expect(descriptor?.outputs[0]).toMatchObject({ id: "text", type: "text" });
    expect(descriptor?.params[0]).toMatchObject({ id: "suffix", type: "string", default: "" });
  } finally {
    host.dispose();
  }
});

test("runs the example plugin and appends the suffix", async () => {
  const host = createHost();
  try {
    await host.load([fixtureSource()]);
    const result = await host.run("example-uppercase/uppercase", {
      inputs: { text: [{ type: "text", text: "hello" }] },
      params: { suffix: "!" },
    });
    expect(result.outputs.text).toEqual([{ type: "text", text: "HELLO!" }]);
  } finally {
    host.dispose();
  }
});

test("accepts a link on a text port and rejects an image", async () => {
  expect(portAccepts("text", "link")).toBe(true);
  expect(portAccepts("link", "text")).toBe(false);
  expect(portAccepts("image", "image")).toBe(true);

  const host = createHost();
  try {
    await host.load([fixtureSource()]);
    const descriptor = host.getProcessor("example-uppercase/uppercase");
    expect(descriptor).toBeDefined();

    const linkRequest: ProcessorRunRequest = {
      inputs: { text: [{ type: "link", url: "https://example.com/a" }] },
      params: {},
    };
    const accepted = validateRunRequest(descriptor as NonNullable<typeof descriptor>, linkRequest);
    expect(accepted.ok).toBe(true);

    const imageRequest: ProcessorRunRequest = {
      inputs: { text: [{ type: "image", mime: "image/png", data: new Uint8Array([1, 2, 3]) }] },
      params: {},
    };
    const rejected = validateRunRequest(descriptor as NonNullable<typeof descriptor>, imageRequest);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("不接受图片值");

    const result = await host.run("example-uppercase/uppercase", linkRequest);
    expect(result.outputs.text).toEqual([{ type: "text", text: "HTTPS://EXAMPLE.COM/A" }]);
    await expect(host.run("example-uppercase/uppercase", imageRequest)).rejects.toThrow(/不接受图片值/);
  } finally {
    host.dispose();
  }
});

test("reports invalid manifests and duplicate plugin ids as error statuses", async () => {
  const host = createHost();
  try {
    const statuses = await host.load([
      plugin("wrong-api", { apiVersion: 2, id: "wrong-api", name: "Wrong", version: "1.0.0" }, ""),
      plugin("bad-id", { apiVersion: 1, id: "Bad_Id", name: "Bad", version: "1.0.0" }, ""),
      fixtureSource(),
      { ...fixtureSource(), folder: "example-copy" },
    ]);

    expect(statuses.map((status) => status.status)).toEqual(["error", "error", "ready", "error"]);
    expect(statuses[0].error).toContain("apiVersion");
    expect(statuses[1].error).toContain("插件 id");
    expect(statuses[3].error).toContain("重复");
    expect(host.list().filter((status) => status.status === "ready")).toHaveLength(1);
  } finally {
    host.dispose();
  }
});

test("rejects run results with undeclared ports or wrong value types", async () => {
  const host = createHost();
  try {
    await host.load([
      plugin("extra-output", manifestFor("extra-output"), `
        picboard.registerProcessor({
          id: "produce",
          title: "多余输出",
          inputs: [],
          outputs: [{ id: "text", label: "文本", type: "text" }],
          params: [],
          run() { return { outputs: { text: [{ type: "text", text: "ok" }], extra: [{ type: "text", text: "no" }] } }; },
        });
      `),
      plugin("wrong-type", manifestFor("wrong-type"), `
        picboard.registerProcessor({
          id: "produce",
          title: "类型错误",
          inputs: [],
          outputs: [{ id: "text", label: "文本", type: "text" }],
          params: [],
          run() { return { outputs: { text: [{ type: "link", url: "https://example.com" }] } }; },
        });
      `),
    ]);

    await expect(host.run("extra-output/produce", { inputs: {}, params: {} }))
      .rejects.toThrow(/未声明的输出端口：extra/);
    await expect(host.run("wrong-type/produce", { inputs: {}, params: {} }))
      .rejects.toThrow(/值类型必须是文本/);
  } finally {
    host.dispose();
  }
});

test("removes network and escape APIs before plugin code runs", async () => {
  let capturedScope: SandboxScope | undefined;
  const host = createHost({ onScope: (scope) => { capturedScope = scope; } });
  try {
    const code = `
      picboard.registerProcessor({
        id: "globals",
        title: "报告全局",
        inputs: [],
        outputs: [{ id: "text", label: "文本", type: "text" }],
        params: [],
        run() {
          return { outputs: { text: [{ type: "text", text: JSON.stringify({
            fetch: typeof fetch,
            XMLHttpRequest: typeof XMLHttpRequest,
            WebSocket: typeof WebSocket,
            EventSource: typeof EventSource,
            importScripts: typeof importScripts,
            indexedDB: typeof indexedDB,
            caches: typeof caches,
            BroadcastChannel: typeof BroadcastChannel,
            Worker: typeof Worker,
            SharedWorker: typeof SharedWorker,
          }) }] } };
        },
      });
    `;
    const statuses = await host.load([plugin("globals", manifestFor("globals"), code)]);
    expect(statuses[0].status, JSON.stringify(statuses[0])).toBe("ready");

    const result = await host.run("globals/globals", { inputs: {}, params: {} });
    const value = result.outputs.text[0];
    expect(value.type).toBe("text");
    if (value.type !== "text") return;

    const reported = JSON.parse(value.text) as Record<string, string>;
    for (const name of Object.keys(reported)) expect(reported[name], name).toBe("undefined");

    const scope = capturedScope as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(scope, "fetch");
    expect(descriptor?.value).toBeUndefined();
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  } finally {
    host.dispose();
  }
});

test("times out a run that never resolves and marks the plugin as error", async () => {
  const host = createHost({ runTimeoutMs: 40 });
  try {
    const statuses = await host.load([
      plugin("hanging", manifestFor("hanging"), `
        picboard.registerProcessor({
          id: "never",
          title: "永不返回",
          inputs: [],
          outputs: [],
          params: [],
          run() { return new Promise(() => {}); },
        });
      `),
    ]);
    expect(statuses[0].status).toBe("ready");

    await expect(host.run("hanging/never", { inputs: {}, params: {} })).rejects.toThrow("运行超时");
    expect(host.list()[0].status).toBe("error");
    expect(host.list()[0].error).toBe("运行超时");
    await expect(host.run("hanging/never", { inputs: {}, params: {} })).rejects.toThrow(/插件不可用/);
  } finally {
    host.dispose();
  }
});

test("aborting a run cancels it and rejects", async () => {
  const host = createHost({ runTimeoutMs: 1000 });
  try {
    await host.load([
      plugin("slow", manifestFor("slow"), `
        picboard.registerProcessor({
          id: "wait",
          title: "等待取消",
          inputs: [],
          outputs: [{ id: "text", label: "文本", type: "text" }],
          params: [],
          run(request, context) {
            return new Promise((resolve, reject) => {
              context.signal.addEventListener("abort", () => reject(new Error("已取消")));
            });
          },
        });
      `),
    ]);

    const controller = new AbortController();
    const pending = host.run("slow/wait", { inputs: {}, params: {} }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("运行已取消");
    expect(host.list()[0].status).toBe("ready");
  } finally {
    host.dispose();
  }
});
