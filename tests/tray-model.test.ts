import { describe, expect, it } from "vitest";
import type { ContentRecord } from "../shared/image-board";
import {
  clampMenuPoint,
  filterTrayContents,
  isFreshRevision,
  isSearchShortcutKey,
  moveSelection,
  todayCount,
  trayTabCounts,
  trayTabMatches,
  TRAY_TAB_LABEL,
} from "../renderer/src/tray/tray-model";

const NOW = Date.parse("2026-05-15T12:00:00");

function content(overrides: Partial<ContentRecord> & { id: string }): ContentRecord {
  return {
    kind: "text",
    preview: "",
    textLength: 0,
    url: null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: new Date(NOW - 26 * 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 26 * 3_600_000).toISOString(),
    lastUsedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

const items: ContentRecord[] = [
  content({ id: "recent", kind: "image", preview: "shot.png", lastUsedAt: new Date(NOW).toISOString() }),
  content({ id: "rich", kind: "richText", preview: "富文本", lastUsedAt: new Date(NOW - 1_000).toISOString() }),
  content({ id: "link", kind: "link", url: "https://example.com", preview: "https://example.com", lastUsedAt: new Date(NOW - 2_000).toISOString() }),
  content({ id: "plain", kind: "text", preview: "普通文本", lastUsedAt: new Date(NOW - 3_000).toISOString() }),
];

describe("tray tabs", () => {
  it("labels tabs and counts kinds, with 文本 covering both text kinds", () => {
    expect(TRAY_TAB_LABEL.text).toBe("文本");
    const counts = trayTabCounts(items);
    expect(counts).toEqual({ all: 4, text: 2, image: 1, link: 1 });
    expect(trayTabMatches(items[1], "text")).toBe(true);
    expect(trayTabMatches(items[0], "text")).toBe(false);
  });

  it("filters by tab and search, newest lastUsedAt first", () => {
    const text = filterTrayContents(items, "text", "");
    expect(text.map((item) => item.id)).toEqual(["rich", "plain"]);
    expect(filterTrayContents(items, "image", "shot").map((item) => item.id)).toEqual(["recent"]);
    expect(filterTrayContents(items, "all", "没有")).toEqual([]);
  });
});

describe("tray stats", () => {
  it("counts contents created today by createdAt", () => {
    const fresh = [...items, content({ id: "today", createdAt: new Date(NOW - 10).toISOString() })];
    expect(todayCount(fresh, NOW)).toBe(1);
    expect(todayCount(items, NOW)).toBe(0);
    expect(todayCount([], NOW)).toBe(0);
  });
});

describe("revision guard", () => {
  it("keeps the highest revision and accepts unordered snapshots", () => {
    expect(isFreshRevision(null, { revision: 7 })).toBe(true);
    expect(isFreshRevision(7, { revision: 7 })).toBe(true);
    expect(isFreshRevision(7, { revision: 8 })).toBe(true);
    expect(isFreshRevision(7, { revision: 6 })).toBe(false);
    expect(isFreshRevision(3, { nope: true })).toBe(true);
    expect(isFreshRevision(3, null)).toBe(true);
  });
});

describe("keyboard selection", () => {
  it("moves within bounds and starts from the ends when nothing is selected", () => {
    expect(moveSelection("ArrowDown", -1, 4)).toBe(0);
    expect(moveSelection("ArrowUp", -1, 4)).toBe(3);
    expect(moveSelection("ArrowDown", 3, 4)).toBe(3);
    expect(moveSelection("ArrowUp", 0, 4)).toBe(0);
    expect(moveSelection("ArrowDown", 1, 4)).toBe(2);
    expect(moveSelection("ArrowUp", 2, 4)).toBe(1);
    expect(moveSelection("ArrowDown", 0, 0)).toBe(-1);
  });
});

describe("menu clamping", () => {
  it("keeps the menu inside the window", () => {
    expect(clampMenuPoint(10, 10, 100, 200, 420, 600)).toEqual({ x: 10, y: 10 });
    expect(clampMenuPoint(400, 580, 100, 200, 420, 600)).toEqual({ x: 312, y: 392 });
    expect(clampMenuPoint(-50, -50, 100, 200, 420, 600)).toEqual({ x: 8, y: 8 });
    expect(clampMenuPoint(10, 10, 200, 700, 120, 200)).toEqual({ x: 8, y: 8 });
  });
});

describe("search shortcut", () => {
  it("only reacts to printable unmodified keys outside editable targets", () => {
    expect(isSearchShortcutKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false }, false)).toBe(true);
    expect(isSearchShortcutKey({ key: "中", ctrlKey: false, metaKey: false, altKey: false }, false)).toBe(true);
    expect(isSearchShortcutKey({ key: "ArrowDown", ctrlKey: false, metaKey: false, altKey: false }, false)).toBe(false);
    expect(isSearchShortcutKey({ key: "a", ctrlKey: true, metaKey: false, altKey: false }, false)).toBe(false);
    expect(isSearchShortcutKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false }, true)).toBe(false);
  });
});
