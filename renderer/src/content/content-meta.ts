import type { AppState, ContentKind, ContentRecord } from "../../../shared/image-board";

/**
 * Presentation helpers for content surfaces (pages, library, history).
 *
 * Pure on purpose: no React, no host access, so every rule here is unit
 * testable and shared by all lanes.
 */

export const KIND_LABEL: Record<ContentKind, string> = {
  text: "富文本",
  richText: "富文本",
  link: "链接",
  image: "图片",
};

/** Storage keeps legacy text; content surfaces expose one rich-text kind. */
export type DisplayContentKind = Exclude<ContentKind, "text">;

export const KIND_ORDER: DisplayContentKind[] = ["richText", "link", "image"];

export function displayContentKind(kind: ContentKind): DisplayContentKind {
  return kind === "text" ? "richText" : kind;
}

/** Both stored text kinds belong to the same user-facing filter. */
export function matchesContentKind(content: ContentRecord, filter: ContentKind | "all"): boolean {
  return filter === "all" || displayContentKind(content.kind) === displayContentKind(filter);
}

const UNTITLED = "未命名";
const MAX_TITLE_LENGTH = 60;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Short, human-meaningful title for a content card or page. */
export function contentTitle(content: ContentRecord): string {
  if (content.kind === "link") return content.url ? linkDomain(content.url) : UNTITLED;
  if (content.kind === "image") return content.image?.fileName || UNTITLED;

  const firstLine = (content.preview ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return UNTITLED;
  return firstLine.length > MAX_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : firstLine;
}

/** Hostname of a URL without a leading "www."; unparsable input is returned as-is. */
export function linkDomain(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return url;
  try {
    const host = new URL(raw).hostname.replace(/^www\./i, "");
    return host || url;
  } catch {
    return url;
  }
}

/** A reference to an image stored inside a text/richText content. */
export interface AssetRef {
  contentId: string;
  assetId: string;
}

/** `"<contentId>/<assetId>"` as stored in `coverAsset` and `img[data-asset]`. */
export function assetRef(contentId: string, assetId: string): string {
  return `${contentId}/${assetId}`;
}

/** Split a stored asset reference; malformed values return null. */
export function parseAssetRef(value: string | null | undefined): AssetRef | null {
  if (!value) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  const contentId = value.slice(0, slash);
  const assetId = value.slice(slash + 1);
  return contentId && assetId ? { contentId, assetId } : null;
}

/** True only for absolute http(s) URLs. */
export function isHttpUrl(value: string): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** "刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / M月D日 / YYYY年M月D日". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const current = new Date(now);
  const date = new Date(time);
  const diff = Math.max(0, now - time);

  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (isSameDay(date, current)) return `${Math.floor(diff / HOUR)} 小时前`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) return `昨天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  if (date.getFullYear() === current.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Full local timestamp for `title` tooltips: YYYY年M月D日 HH:mm. */
export function formatTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const date = new Date(time);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Compact file size for image metadata. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${trimDecimal(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimDecimal(mb)} MB`;
  return `${trimDecimal(mb / 1024)} GB`;
}

/** contentId → distinct ids of the canvases that place it, in canvas order. */
export function buildPlacementIndex(state: AppState): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const canvas of state.canvases) {
    const seen = new Set<string>();
    for (const node of canvas.nodes) {
      if (seen.has(node.contentId)) continue;
      seen.add(node.contentId);
      const existing = index.get(node.contentId);
      if (existing) existing.push(canvas.id);
      else index.set(node.contentId, [canvas.id]);
    }
  }
  return index;
}

/** Case-insensitive substring match over preview, URL and image file name. */
export function matchesQuery(content: ContentRecord, query: string): boolean {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return true;
  const haystack = [content.preview, content.url, content.image?.fileName]
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
