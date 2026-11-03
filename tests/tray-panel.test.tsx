// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AppState, ContentRecord } from "../shared/image-board";
import TrayPanel from "../renderer/src/tray/TrayPanel";

Element.prototype.scrollIntoView = function () {};

const NOW = "2026-05-15T12:00:00.000Z";
const REAL_NOW = new Date().toISOString();

function content(id: string, overrides: Partial<ContentRecord> = {}): ContentRecord {
  return {
    id,
    kind: "text",
    preview: `preview ${id}`,
    textLength: 10,
    url: null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: REAL_NOW,
    updatedAt: REAL_NOW,
    lastUsedAt: REAL_NOW,
    ...overrides,
  };
}

function state(ids: string[], revision: number): AppState {
  const contents: Record<string, ContentRecord> = {};
  for (const id of ids) contents[id] = content(id);
  // "a" is older so "b" sorts first and the newest-first assertions are stable.
  if (contents.a) contents.a.lastUsedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    revision,
    activeCanvasId: "root",
    canvases: [],
    categories: [{ id: "cat1", name: "灵感", createdAt: NOW }],
    contents,
    edges: [],
  };
}

interface HostMocks {
  loadState: Mock;
  onStateChanged: Mock;
  copyContents: Mock;
  deleteContents: Mock;
  classifyContents: Mock;
  createCategory: Mock;
  getContentBody: Mock;
  showMainWindow: Mock;
  hideTrayPanel: Mock;
  quitApp: Mock;
  setDesktopSettings: Mock;
  stateChangedListener: ((state: AppState) => void) | null;
}

let mocks: HostMocks;

beforeEach(() => {
  mocks = {
    loadState: vi.fn(async () => state(["a", "b"], 5)),
    onStateChanged: vi.fn((listener: (next: AppState) => void) => {
      mocks.stateChangedListener = listener;
      return () => {
        mocks.stateChangedListener = null;
      };
    }),
    copyContents: vi.fn(async () => ({ copied: 1 })),
    deleteContents: vi.fn(async () => state(["a"], 6)),
    classifyContents: vi.fn(async () => state(["a", "b"], 6)),
    createCategory: vi.fn(async () => ({
      ...state(["a", "b"], 7),
      categories: [
        { id: "cat1", name: "灵感", createdAt: NOW },
        { id: "cat2", name: "新分类", createdAt: NOW },
      ],
    })),
    getContentBody: vi.fn(async () => ({ text: "全文内容\n第二行", html: null })),
    getDesktopSettings: vi.fn(async () => ({
      closeBehavior: "tray" as const,
      autoStart: false,
      autoStartAvailable: false,
      captureEnabled: true,
      historyRetentionDays: 30 as const,
      snapToGrid: false,
      gridSize: 24 as const,
    })),
    showMainWindow: vi.fn(async () => {}),
    hideTrayPanel: vi.fn(async () => {}),
    quitApp: vi.fn(async () => {}),
    setDesktopSettings: vi.fn(async (patch: { captureEnabled?: boolean }) => ({
      closeBehavior: "tray" as const,
      autoStart: false,
      autoStartAvailable: false,
      captureEnabled: patch.captureEnabled ?? true,
      historyRetentionDays: 30 as const,
      snapToGrid: false,
      gridSize: 24 as const,
    })),
    stateChangedListener: null,
  };
  window.imageBoard = mocks as unknown as typeof window.imageBoard;
});

afterEach(cleanup);

function card(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.tray-item[data-content-id="${id}"]`);
  if (!element) throw new Error(`card ${id} not mounted`);
  return element;
}

test("renders header, tabs with counts, stats and the newest-first list", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  expect(document.querySelector(".tray-name")?.textContent).toBe("PicBoard");
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>(".tray-tab")).map((chip) => chip.textContent);
  expect(chips.some((label) => label?.startsWith("全部") && label.includes("2"))).toBe(true);
  expect(chips.some((label) => label?.startsWith("富文本") && label.includes("2"))).toBe(true);
  expect(document.querySelector(".tray-stats")?.textContent).toContain("今天 2 条");
  expect(document.querySelector(".tray-stats")?.textContent).toContain("共 2 条");
  // "b" has the newer lastUsedAt, so it is listed first.
  expect(document.querySelector(".tray-item")?.getAttribute("data-content-id")).toBe("b");
});

test("clicking a card copies it and shows the spring copied state", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.click(card("a"));
  await waitFor(() => expect(mocks.copyContents).toHaveBeenCalledWith(["a"]));
  expect(document.querySelector(".tray-copied")?.textContent).toContain("已复制");
  expect(mocks.hideTrayPanel).not.toHaveBeenCalled();
});

test("double-click opens the content in the main window", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.doubleClick(card("b"));
  await waitFor(() => expect(mocks.showMainWindow).toHaveBeenCalledWith({ contentId: "b" }));
});

test("the chevron expands the full plain text inline", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.click(document.querySelector<HTMLButtonElement>('.tray-item[data-content-id="a"] .tray-item-chevron')!);
  await waitFor(() => expect(document.querySelector('.tray-item[data-content-id="a"] .tray-expand')?.className).toContain("is-open"));
  await waitFor(() => expect(document.querySelector('.tray-item[data-content-id="a"] .tray-expand-text')?.textContent).toContain("第二行"));
  expect(mocks.getContentBody).toHaveBeenCalledWith("a");
});

test("keyboard drives selection, copy and preview; Esc hides the panel", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  await waitFor(() => expect(card("b").className).toContain("is-selected"));
  fireEvent.keyDown(window, { key: "Enter" });
  await waitFor(() => expect(mocks.copyContents).toHaveBeenCalledWith(["b"]));
  fireEvent.keyDown(window, { key: " " });
  await waitFor(() => expect(document.querySelector('.tray-item[data-content-id="b"] .tray-expand')?.className).toContain("is-open"));
  // Esc peels layers first: the open preview collapses, the next Esc hides the panel.
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(document.querySelector('.tray-item[data-content-id="b"] .tray-expand')?.className).not.toContain("is-open"));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(mocks.hideTrayPanel).toHaveBeenCalled());
});

test("typing anywhere focuses the search field", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.keyDown(window, { key: "s" });
  const input = document.querySelector<HTMLInputElement>(".tray-search input")!;
  expect(document.activeElement).toBe(input);
  await waitFor(() => expect(input.value).toBe("s"));
});

test("the context menu deletes through an inline confirm", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.contextMenu(card("a"));
  await waitFor(() => expect(document.querySelector(".tray-menu")).toBeTruthy());
  fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>(".tray-menu-item")).find((item) => item.textContent === "删除内容")!);
  await waitFor(() => expect(document.querySelector(".tray-confirm")?.textContent).toContain("从所有画布删除，无法恢复"));
  fireEvent.click(document.querySelector<HTMLButtonElement>(".tray-confirm-delete")!);
  await waitFor(() => expect(mocks.deleteContents).toHaveBeenCalledWith(["a"]));
});

test("the category submenu classifies and creates categories", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.contextMenu(card("a"));
  await waitFor(() => expect(document.querySelector(".tray-menu")).toBeTruthy());
  fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>(".tray-menu-item")).find((item) => item.textContent?.includes("分类") && !item.textContent?.includes("取消"))!);
  await waitFor(() => expect(document.querySelector(".tray-menu-list")).toBeTruthy());
  fireEvent.click(Array.from(document.querySelectorAll<HTMLButtonElement>(".tray-menu-item")).find((item) => item.textContent === "灵感")!);
  await waitFor(() => expect(mocks.classifyContents).toHaveBeenCalledWith(["a"], "cat1"));
});

test("drops older revisions and applies newer pushes", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  const stale = state(["a"], 2);
  mocks.stateChangedListener?.(stale);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  const fresh = state(["a", "b", "c"], 9);
  mocks.stateChangedListener?.(fresh);
  await waitFor(() => expect(card("c")).toBeTruthy());
});

test("footer buttons open the main window and quit", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.click(document.querySelector<HTMLButtonElement>(".tray-foot-main")!);
  await waitFor(() => expect(mocks.showMainWindow).toHaveBeenCalledWith(undefined));
  fireEvent.click(document.querySelector<HTMLButtonElement>(".tray-foot-quit")!);
  await waitFor(() => expect(mocks.quitApp).toHaveBeenCalled());
});

test("the capture toggle records or pauses via desktop settings", async () => {
  render(<TrayPanel />);
  await waitFor(() => expect(document.querySelectorAll(".tray-item")).toHaveLength(2));
  fireEvent.click(document.querySelector<HTMLButtonElement>('.tray-head .tray-icon-button[aria-pressed]')!);
  await waitFor(() => expect(mocks.setDesktopSettings).toHaveBeenCalledWith({ captureEnabled: false }));
});
