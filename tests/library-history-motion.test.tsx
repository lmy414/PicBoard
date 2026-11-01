// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { AppState, ContentRecord } from "../shared/image-board";
import { LibraryView } from "../renderer/src/library/LibraryView";
import { HistoryDrawer } from "../renderer/src/history/HistoryDrawer";

const NOW = "2026-05-15T04:00:00.000Z";

function content(id: string): ContentRecord {
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
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
  };
}

function makeState(ids: string[]): AppState {
  const contents: Record<string, ContentRecord> = {};
  for (const id of ids) contents[id] = content(id);
  return { activeCanvasId: "root", canvases: [], categories: [], contents, edges: [] };
}

window.imageBoard = {
  imageUrl: (id: string, variant: string) => `image://${variant}/${id}`,
  assetUrl: (cid: string, aid: string, variant: string) => `asset://${variant}/${cid}/${aid}`,
} as unknown as typeof window.imageBoard;

afterEach(cleanup);

test("library cards animate out before leaving the grid", async () => {
  const props = {
    selectedIds: [],
    onSelect: vi.fn(),
    onClearSelection: vi.fn(),
    onOpen: vi.fn(),
    onQuickActions: vi.fn(),
  };
  const view = render(<LibraryView {...props} state={makeState(["a", "b"])} />);
  expect(document.querySelectorAll(".lib-card")).toHaveLength(2);
  view.rerender(<LibraryView {...props} state={makeState(["a"])} />);
  await waitFor(() => expect(document.querySelector(".lib-exit-card")).toBeTruthy());
  await waitFor(() => expect(document.querySelector(".lib-exit-card")).toBeNull(), { timeout: 1200 });
  expect(document.querySelectorAll(".lib-grid > .lib-card")).toHaveLength(1);
});

test("history rows animate out before leaving the list", async () => {
  const props = {
    open: true,
    captureEnabled: true,
    onToggleCapture: vi.fn(),
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onQuickActions: vi.fn(),
    onDropToCanvas: () => false,
  };
  const view = render(<HistoryDrawer {...props} state={makeState(["a", "b"])} />);
  expect(document.querySelectorAll(".hist-item")).toHaveLength(2);
  view.rerender(<HistoryDrawer {...props} state={makeState(["a"])} />);
  await waitFor(() => expect(document.querySelector('.hist-item[data-motion="exit"]')).toBeTruthy());
  await waitFor(() => expect(document.querySelector('.hist-item[data-motion="exit"]')).toBeNull(), { timeout: 1200 });
  expect(document.querySelectorAll(".hist-list > .hist-item")).toHaveLength(1);
});
