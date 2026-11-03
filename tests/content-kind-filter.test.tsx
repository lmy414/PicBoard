// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { AppState, ContentKind, ContentRecord } from "../shared/image-board";
import { HistoryDrawer } from "../renderer/src/history/HistoryDrawer";
import { LibraryView } from "../renderer/src/library/LibraryView";
import { KindIcon } from "../renderer/src/ui/ContentIcons";

const NOW = "2026-05-15T04:00:00.000Z";

function content(id: string, kind: ContentKind): ContentRecord {
  return {
    id, kind, preview: id, textLength: id.length, url: kind === "link" ? "https://example.com" : null,
    image: null, coverAsset: null, categoryId: null, source: "clipboard",
    createdAt: NOW, updatedAt: NOW, lastUsedAt: NOW,
  };
}

function makeState(): AppState {
  return {
    activeCanvasId: "root", canvases: [], categories: [], edges: [],
    contents: { plain: content("plain", "text"), rich: content("rich", "richText"), link: content("link", "link"), image: content("image", "image") },
  };
}

afterEach(cleanup);

test("stored plain text and rich text share the rich-text icon", () => {
  const view = render(<><span data-testid="plain"><KindIcon kind="text" /></span><span data-testid="rich"><KindIcon kind="richText" /></span></>);
  expect(view.getByTestId("plain").innerHTML).toBe(view.getByTestId("rich").innerHTML);
});

test("library merges text filters, counts and search results", () => {
  const state = makeState();
  const onOpen = vi.fn();
  const view = render(<LibraryView state={state} selectedIds={[]} onSelect={vi.fn()} onClearSelection={vi.fn()} onOpen={onOpen} onQuickActions={vi.fn()} />);
  const filters = within(view.getByRole("group", { name: "按类型筛选" }));
  expect(filters.getAllByRole("button")).toHaveLength(4);
  expect(filters.queryByRole("button", { name: /^文本/ })).toBeNull();
  const richFilter = filters.getByRole("button", { name: /富文本\s*2/ });
  fireEvent.click(richFilter);
  expect(richFilter.getAttribute("aria-pressed")).toBe("true");
  const cards = Array.from(view.container.querySelectorAll<HTMLElement>(".lib-grid > .lib-card"));
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["富文本：plain", "富文本：rich"]);
  fireEvent.doubleClick(cards[0]);
  expect(onOpen).toHaveBeenCalledWith("plain");
  fireEvent.change(view.getByRole("textbox", { name: "搜索内容" }), { target: { value: "plain" } });
  expect(view.container.querySelectorAll(".lib-grid > .lib-card")).toHaveLength(1);
  expect(state.contents.plain.kind).toBe("text");
  expect(state.contents.rich.kind).toBe("richText");
});

test("history merges text filters and search results", () => {
  const state = makeState();
  const onOpen = vi.fn();
  const view = render(<HistoryDrawer state={state} open captureEnabled onToggleCapture={vi.fn()} onClose={vi.fn()} onOpen={onOpen} onQuickActions={vi.fn()} onDropToCanvas={() => false} />);
  const filters = within(view.getByRole("group", { name: "按类型筛选" }));
  expect(filters.getAllByRole("button")).toHaveLength(4);
  expect(filters.queryByRole("button", { name: "文本", exact: true })).toBeNull();
  const richFilter = filters.getByRole("button", { name: "富文本", exact: true });
  fireEvent.click(richFilter);
  expect(richFilter.getAttribute("aria-pressed")).toBe("true");
  const rows = Array.from(view.container.querySelectorAll<HTMLElement>('.hist-item:not([data-motion="exit"])'));
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["富文本：plain", "富文本：rich"]);
  fireEvent.doubleClick(rows[0]);
  expect(onOpen).toHaveBeenCalledWith("plain");
  fireEvent.change(view.getByRole("textbox", { name: "搜索剪贴板历史" }), { target: { value: "plain" } });
  expect(view.container.querySelectorAll('.hist-item:not([data-motion="exit"])')).toHaveLength(1);
  expect(state.contents.plain.kind).toBe("text");
  expect(state.contents.rich.kind).toBe("richText");
});
