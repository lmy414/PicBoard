/**
 * Neutral contract for processing-node plugins (interface only).
 *
 * A plugin is a folder with a manifest plus a classic script that registers
 * processors through the injected `picboard` binding. This module holds the
 * wire types and the validators used by both sides: the renderer host, which
 * owns worker lifecycles, and the worker sandbox, which evaluates plugin code.
 *
 * Neutral rules: no DOM, no Tauri, no runtime imports, and erasable-only
 * TypeScript, so `node --test` can import this file with type stripping.
 */

export const PROCESSOR_API_VERSION = 1;

/** What a port carries. Values never change type silently: an image stays an image. */
export type PortType = "text" | "link" | "image";

/**
 * Port compatibility. A text input accepts plain text and links, because a
 * link is text with a URL. Everything else only accepts its own type.
 */
export function portAccepts(input: PortType, output: PortType): boolean {
  if (input === "text") return output === "text" || output === "link";
  return input === output;
}

export function isPortType(value: unknown): value is PortType {
  return value === "text" || value === "link" || value === "image";
}

/** One input or output socket of a processor. */
export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  /** Accepts several values at once. Defaults to false (at most one value). */
  multiple?: boolean;
  /** An input that may be missing from a run request. Defaults to false. */
  optional?: boolean;
}

export interface StringParamSpec {
  id: string;
  label: string;
  type: "string";
  default?: string;
  multiline?: boolean;
}

export interface NumberParamSpec {
  id: string;
  label: string;
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface BooleanParamSpec {
  id: string;
  label: string;
  type: "boolean";
  default?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectParamSpec {
  id: string;
  label: string;
  type: "select";
  options: SelectOption[];
  default?: string;
}

export type ParamSpec = StringParamSpec | NumberParamSpec | BooleanParamSpec | SelectParamSpec;

export type ParamType = ParamSpec["type"];

/**
 * Everything the host needs to show and validate a processor. Plain JSON:
 * it crosses the worker boundary, so it never carries functions.
 */
export interface ProcessorDescriptor {
  id: string;
  title: string;
  description?: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSpec[];
}

export type PortValue =
  | { type: "text"; text: string; html?: string | null }
  | { type: "link"; url: string }
  | { type: "image"; mime: string; data: Uint8Array; width?: number; height?: number };

/** One run, keyed by port id. Single ports hold one value, multiple ports hold many. */
export interface ProcessorRunRequest {
  inputs: Record<string, PortValue[]>;
  params: Record<string, unknown>;
}

export interface ProcessorRunResult {
  outputs: Record<string, PortValue[]>;
}

export interface ProcessorContext {
  /** Aborted when the user cancels or the host hits its run timeout. */
  signal: AbortSignal;
  /** Free-form progress text; the host only logs it in this phase. */
  log(message: string): void;
}

/** What a plugin author writes: a descriptor plus its run function. */
export interface ProcessorDefinition extends ProcessorDescriptor {
  run(
    request: ProcessorRunRequest,
    context: ProcessorContext,
  ): ProcessorRunResult | Promise<ProcessorRunResult>;
}

/** The parsed `manifest.json` of one plugin folder. */
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  /** Entry script inside the plugin folder; defaults to "main.js". */
  main?: string;
  description?: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Plugin and processor ids share one shape: lowercase, digits, hyphens. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LINK_PATTERN = /^https?:\/\/[^\s]+$/i;
const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

const PORT_TYPE_NAMES: Record<PortType, string> = { text: "文本", link: "链接", image: "图片" };

export function portTypeName(type: PortType): string {
  return PORT_TYPE_NAMES[type];
}

/** Fully-qualified id used by the host and the future run action. */
export function qualifiedProcessorId(pluginId: string, processorId: string): string {
  return `${pluginId}/${processorId}`;
}

export function splitProcessorId(fullId: string): { pluginId: string; processorId: string } | null {
  const index = fullId.indexOf("/");
  if (index <= 0 || index === fullId.length - 1) return null;
  const pluginId = fullId.slice(0, index);
  const processorId = fullId.slice(index + 1);
  if (processorId.includes("/")) return null;
  return { pluginId, processorId };
}

/**
 * Canonical guard for untrusted JSON (manifests, worker messages). Fields stay
 * `unknown`; the validators below check the ones they use.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function isRelativeScriptPath(value: string): boolean {
  if (!value.endsWith(".js") || value.length <= 3) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function validateManifest(input: unknown): ValidationResult<PluginManifest> {
  if (!isRecord(input)) return fail("manifest.json 必须是一个 JSON 对象");
  if (input.apiVersion !== PROCESSOR_API_VERSION) {
    return fail(`apiVersion 必须为 ${PROCESSOR_API_VERSION}`);
  }
  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    return fail("插件 id 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  if (!isNonEmptyString(input.name)) return fail("插件 name 不能为空");
  if (!isNonEmptyString(input.version)) return fail("插件 version 不能为空");

  const manifest: PluginManifest = {
    apiVersion: PROCESSOR_API_VERSION,
    id: input.id,
    name: input.name,
    version: input.version,
  };
  if (input.main !== undefined) {
    if (typeof input.main !== "string" || !isRelativeScriptPath(input.main)) {
      return fail("插件 main 必须是插件目录内的相对 .js 路径");
    }
    manifest.main = input.main;
  }
  if (input.description !== undefined) {
    if (typeof input.description !== "string") return fail("插件 description 必须是字符串");
    manifest.description = input.description;
  }
  return { ok: true, value: manifest };
}

export function validateDescriptor(input: unknown): ValidationResult<ProcessorDescriptor> {
  if (!isRecord(input)) return fail("处理器描述必须是一个对象");
  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    return fail("处理器 id 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  if (!isNonEmptyString(input.title)) return fail("处理器 title 不能为空");

  const inputs = readPorts(input.inputs, "输入");
  if (!inputs.ok) return fail(inputs.error);
  const outputs = readPorts(input.outputs, "输出");
  if (!outputs.ok) return fail(outputs.error);
  const params = readParams(input.params);
  if (!params.ok) return fail(params.error);

  const descriptor: ProcessorDescriptor = {
    id: input.id,
    title: input.title,
    inputs: inputs.value,
    outputs: outputs.value,
    params: params.value,
  };
  if (input.description !== undefined) {
    if (typeof input.description !== "string") return fail("处理器 description 必须是字符串");
    descriptor.description = input.description;
  }
  return { ok: true, value: descriptor };
}

function readPorts(input: unknown, direction: "输入" | "输出"): ValidationResult<PortSpec[]> {
  if (!Array.isArray(input)) return fail(`${direction}端口必须是数组`);
  const seen = new Set<string>();
  const ports: PortSpec[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) return fail(`${direction}端口必须是对象`);
    if (!isNonEmptyString(raw.id)) return fail(`${direction}端口的 id 不能为空`);
    if (seen.has(raw.id)) return fail(`${direction}端口 id 重复：${raw.id}`);
    seen.add(raw.id);
    if (!isNonEmptyString(raw.label)) return fail(`${direction}端口 ${raw.id} 的 label 不能为空`);
    if (!isPortType(raw.type)) return fail(`${direction}端口 ${raw.id} 的类型无效`);

    const port: PortSpec = { id: raw.id, label: raw.label, type: raw.type };
    if (raw.multiple !== undefined) {
      if (typeof raw.multiple !== "boolean") return fail(`${direction}端口 ${raw.id} 的 multiple 必须是布尔值`);
      port.multiple = raw.multiple;
    }
    if (raw.optional !== undefined) {
      if (typeof raw.optional !== "boolean") return fail(`${direction}端口 ${raw.id} 的 optional 必须是布尔值`);
      port.optional = raw.optional;
    }
    ports.push(port);
  }
  return { ok: true, value: ports };
}

function readParams(input: unknown): ValidationResult<ParamSpec[]> {
  if (!Array.isArray(input)) return fail("参数列表必须是数组");
  const seen = new Set<string>();
  const params: ParamSpec[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) return fail("参数必须是对象");
    if (!isNonEmptyString(raw.id)) return fail("参数的 id 不能为空");
    if (seen.has(raw.id)) return fail(`参数 id 重复：${raw.id}`);
    seen.add(raw.id);
    if (!isNonEmptyString(raw.label)) return fail(`参数 ${raw.id} 的 label 不能为空`);
    const spec = readParam(raw, raw.id, raw.label);
    if (!spec.ok) return fail(spec.error);
    params.push(spec.value);
  }
  return { ok: true, value: params };
}

function readParam(
  raw: Record<string, unknown>,
  id: string,
  label: string,
): ValidationResult<ParamSpec> {
  switch (raw.type) {
    case "string": {
      if (raw.default !== undefined && typeof raw.default !== "string") {
        return fail(`参数 ${id} 的默认值必须是字符串`);
      }
      if (raw.multiline !== undefined && typeof raw.multiline !== "boolean") {
        return fail(`参数 ${id} 的 multiline 必须是布尔值`);
      }
      const spec: StringParamSpec = { id, label, type: "string" };
      if (raw.default !== undefined) spec.default = raw.default;
      if (raw.multiline !== undefined) spec.multiline = raw.multiline;
      return { ok: true, value: spec };
    }
    case "number": {
      for (const key of ["default", "min", "max", "step"] as const) {
        if (raw[key] !== undefined && !isFiniteNumber(raw[key])) {
          return fail(`参数 ${id} 的 ${key} 必须是有限数字`);
        }
      }
      const min = raw.min as number | undefined;
      const max = raw.max as number | undefined;
      const step = raw.step as number | undefined;
      const fallback = raw.default as number | undefined;
      if (min !== undefined && max !== undefined && min > max) return fail(`参数 ${id} 的 min 不能大于 max`);
      if (step !== undefined && step <= 0) return fail(`参数 ${id} 的 step 必须大于 0`);
      if (fallback !== undefined && min !== undefined && fallback < min) return fail(`参数 ${id} 的默认值小于 min`);
      if (fallback !== undefined && max !== undefined && fallback > max) return fail(`参数 ${id} 的默认值大于 max`);
      const spec: NumberParamSpec = { id, label, type: "number" };
      if (fallback !== undefined) spec.default = fallback;
      if (min !== undefined) spec.min = min;
      if (max !== undefined) spec.max = max;
      if (step !== undefined) spec.step = step;
      return { ok: true, value: spec };
    }
    case "boolean": {
      if (raw.default !== undefined && typeof raw.default !== "boolean") {
        return fail(`参数 ${id} 的默认值必须是布尔值`);
      }
      const spec: BooleanParamSpec = { id, label, type: "boolean" };
      if (raw.default !== undefined) spec.default = raw.default;
      return { ok: true, value: spec };
    }
    case "select": {
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        return fail(`参数 ${id} 的 options 不能为空`);
      }
      const values = new Set<string>();
      const options: SelectOption[] = [];
      for (const option of raw.options) {
        if (!isRecord(option)) return fail(`参数 ${id} 的选项必须是对象`);
        if (!isNonEmptyString(option.value)) return fail(`参数 ${id} 的选项 value 不能为空`);
        if (!isNonEmptyString(option.label)) return fail(`参数 ${id} 的选项 label 不能为空`);
        if (values.has(option.value)) return fail(`参数 ${id} 的选项 value 重复：${option.value}`);
        values.add(option.value);
        options.push({ value: option.value, label: option.label });
      }
      if (raw.default !== undefined) {
        if (typeof raw.default !== "string" || !values.has(raw.default)) {
          return fail(`参数 ${id} 的默认值必须是选项之一`);
        }
      }
      const spec: SelectParamSpec = { id, label, type: "select", options };
      if (raw.default !== undefined) spec.default = raw.default;
      return { ok: true, value: spec };
    }
    default:
      return fail(`参数 ${id} 的类型无效`);
  }
}

/** Validates one port value and returns a plain copy of it. */
export function validatePortValue(input: unknown): ValidationResult<PortValue> {
  if (!isRecord(input)) return fail("端口值必须是对象");
  switch (input.type) {
    case "text": {
      if (typeof input.text !== "string") return fail("文本值缺少 text 字段");
      const value: PortValue = { type: "text", text: input.text };
      if (input.html !== undefined) {
        if (input.html !== null && typeof input.html !== "string") {
          return fail("文本值的 html 必须是字符串或 null");
        }
        value.html = input.html;
      }
      return { ok: true, value };
    }
    case "link": {
      if (typeof input.url !== "string" || !LINK_PATTERN.test(input.url)) {
        return fail("链接值必须是绝对 http(s) URL");
      }
      return { ok: true, value: { type: "link", url: input.url } };
    }
    case "image": {
      if (!isNonEmptyString(input.mime) || !MIME_PATTERN.test(input.mime)) {
        return fail("图片值缺少有效的 mime");
      }
      if (!(input.data instanceof Uint8Array)) return fail("图片值缺少 Uint8Array 数据");
      const value: PortValue = { type: "image", mime: input.mime, data: input.data };
      const width = input.width;
      if (width !== undefined) {
        if (!isFiniteNumber(width) || width <= 0) return fail("图片值的 width 必须是正数");
        value.width = width;
      }
      const height = input.height;
      if (height !== undefined) {
        if (!isFiniteNumber(height) || height <= 0) return fail("图片值的 height 必须是正数");
        value.height = height;
      }
      return { ok: true, value };
    }
    default:
      return fail("端口值的 type 无效");
  }
}

/**
 * Checks a run request against a descriptor and returns a normalized copy:
 * defaults are filled in, numbers arrive as numbers, and unknown keys fail.
 */
export function validateRunRequest(
  descriptor: ProcessorDescriptor,
  input: unknown,
): ValidationResult<ProcessorRunRequest> {
  if (!isRecord(input)) return fail("运行请求必须是对象");

  const rawInputs = input.inputs === undefined ? {} : input.inputs;
  if (!isRecord(rawInputs)) return fail("inputs 必须是对象");
  const declaredInputs = new Map(descriptor.inputs.map((port) => [port.id, port]));
  for (const key of Object.keys(rawInputs)) {
    if (!declaredInputs.has(key)) return fail(`未声明的输入端口：${key}`);
  }

  const inputs: Record<string, PortValue[]> = {};
  for (const port of descriptor.inputs) {
    const raw = rawInputs[port.id];
    if (raw === undefined) {
      if (port.optional) continue;
      return fail(`缺少必需输入：${port.id}`);
    }
    if (!Array.isArray(raw)) return fail(`输入 ${port.id} 必须是数组`);
    if (!port.multiple && raw.length > 1) return fail(`输入 ${port.id} 只接受一个值`);
    if (raw.length === 0) {
      if (port.optional) {
        inputs[port.id] = [];
        continue;
      }
      return fail(`缺少必需输入：${port.id}`);
    }
    const values: PortValue[] = [];
    for (const item of raw) {
      const checked = validatePortValue(item);
      if (!checked.ok) return fail(`输入 ${port.id}：${checked.error}`);
      if (!portAccepts(port.type, checked.value.type)) {
        return fail(`输入 ${port.id} 不接受${portTypeName(checked.value.type)}值`);
      }
      values.push(checked.value);
    }
    inputs[port.id] = values;
  }

  const rawParams = input.params === undefined ? {} : input.params;
  if (!isRecord(rawParams)) return fail("params 必须是对象");
  const declaredParams = new Map(descriptor.params.map((param) => [param.id, param]));
  for (const key of Object.keys(rawParams)) {
    if (!declaredParams.has(key)) return fail(`未声明的参数：${key}`);
  }

  const params: Record<string, unknown> = {};
  for (const spec of descriptor.params) {
    const raw = rawParams[spec.id];
    if (raw === undefined) {
      if (spec.default !== undefined) params[spec.id] = spec.default;
      continue;
    }
    const coerced = coerceParam(spec, raw);
    if (!coerced.ok) return fail(`参数 ${spec.id}：${coerced.error}`);
    params[spec.id] = coerced.value;
  }

  return { ok: true, value: { inputs, params } };
}

function coerceParam(spec: ParamSpec, raw: unknown): ValidationResult<unknown> {
  switch (spec.type) {
    case "string": {
      if (typeof raw === "string") return { ok: true, value: raw };
      if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: String(raw) };
      if (typeof raw === "boolean") return { ok: true, value: String(raw) };
      return fail("必须是字符串");
    }
    case "number": {
      let value: number | null = null;
      if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
      else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) value = Number(raw);
      if (value === null) return fail("必须是数字");
      if (spec.min !== undefined && value < spec.min) return fail(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) return fail(`不能大于 ${spec.max}`);
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return fail("必须是布尔值");
    }
    case "select": {
      if (typeof raw === "string" && spec.options.some((option) => option.value === raw)) {
        return { ok: true, value: raw };
      }
      return fail(`必须是选项之一：${spec.options.map((option) => option.value).join("、")}`);
    }
    default:
      return fail("类型无效");
  }
}

/**
 * Checks a run result against a descriptor. Output values must match their
 * port type exactly; a text port does not accept a link here, because a
 * downstream text port cannot assume every producer keeps the URL semantics.
 */
export function validateRunResult(
  descriptor: ProcessorDescriptor,
  input: unknown,
): ValidationResult<ProcessorRunResult> {
  if (!isRecord(input)) return fail("运行结果必须是对象");
  if (!isRecord(input.outputs)) return fail("运行结果的 outputs 必须是对象");

  const declared = new Map(descriptor.outputs.map((port) => [port.id, port]));
  const outputs: Record<string, PortValue[]> = {};
  for (const key of Object.keys(input.outputs)) {
    if (!declared.has(key)) return fail(`未声明的输出端口：${key}`);
  }
  for (const port of descriptor.outputs) {
    const raw = input.outputs[port.id];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) return fail(`输出 ${port.id} 必须是数组`);
    if (!port.multiple && raw.length > 1) return fail(`输出 ${port.id} 只允许一个值`);
    const values: PortValue[] = [];
    for (const item of raw) {
      const checked = validatePortValue(item);
      if (!checked.ok) return fail(`输出 ${port.id}：${checked.error}`);
      if (checked.value.type !== port.type) {
        return fail(`输出 ${port.id} 的值类型必须是${portTypeName(port.type)}`);
      }
      values.push(checked.value);
    }
    outputs[port.id] = values;
  }
  return { ok: true, value: { outputs } };
}
