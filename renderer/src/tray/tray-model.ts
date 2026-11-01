import type { ContentRecord } from "../../../shared/image-board";
import { matchesQuery } from "../content/content-meta";

/**
 * Pure logic for the tray flyout: tabs, filtering, counts, revision guard,
 * keyboard selection and menu clamping. No React, no host access.
 */

export type TrayTab = "all" | "text" | "image" | "link";

export const TRAY_TABS: TrayTab[] = ["all", "text", "image", "link"];

export const TRAY_TAB_LABEL: Record<TrayTab, string> = {
  all: "全部",
  text: "文本",
  image: "图片",
  link: "链接",
};

/** The 文本 tab covers both plain and rich text. */
export function trayTabMatches(content: ContentRecord, tab: TrayTab): boolean {
  if (tab === "all") return true;
  if (tab === "text") return content.kind === "text" || content.kind === "richText";
  return content.kind === tab;
}

export function trayTabCounts(contents: ContentRecord[]): Record<TrayTab, number> {
  const counts: Record<TrayTab, number> = { all: contents.length, text: 0, image: 0, link: 0 };
  for (const content of contents) {
    if (trayTabMatches(content, "text")) counts.text += 1;
    if (trayTabMatches(content, "image")) counts.image += 1;
    if (trayTabMatches(content, "link")) counts.link += 1;
  }
  return counts;
}

function lastUsedTimestamp(content: ContentRecord): number {
  const time = Date.parse(content.lastUsedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Newest `lastUsedAt` first, filtered by tab and search. */
export function filterTrayContents(contents: ContentRecord[], tab: TrayTab, query: string): ContentRecord[] {
  return contents
    .filter((content) => trayTabMatches(content, tab) && matchesQuery(content, query))
    .sort((left, right) => lastUsedTimestamp(right) - lastUsedTimestamp(left));
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Contents captured today, by `createdAt`. */
export function todayCount(contents: ContentRecord[], now: number = Date.now()): number {
  const start = startOfLocalDay(now);
  return contents.filter((content) => {
    const created = Date.parse(content.createdAt);
    return Number.isFinite(created) && created >= start;
  }).length;
}

/**
 * Only accept snapshots that are at least as new as the highest revision seen.
 * Snapshots without a usable revision cannot be ordered and are accepted.
 */
export function isFreshRevision(seen: number | null, snapshot: unknown): boolean {
  if (typeof snapshot !== "object" || snapshot === null || !("revision" in snapshot)) return true;
  const revision = snapshot.revision;
  if (typeof revision !== "number" || !Number.isFinite(revision)) return true;
  if (seen === null) return true;
  return revision >= seen;
}

/** ↑/↓ move the selection within bounds; -1 means "nothing selected". */
export function moveSelection(key: "ArrowUp" | "ArrowDown", index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return key === "ArrowUp" ? length - 1 : 0;
  if (key === "ArrowUp") return Math.max(0, index - 1);
  return Math.min(length - 1, index + 1);
}

/** Keep a floating menu inside the window with a small margin. */
export function clampMenuPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const margin = 8;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

/** Printable, unmodified keys focus the tray search when nothing editable holds focus. */
export function isSearchShortcutKey(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  editableTarget: boolean,
): boolean {
  if (editableTarget) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1;
}
