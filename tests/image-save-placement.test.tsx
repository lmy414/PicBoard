// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../renderer/src/App";
import type { AppState, ContentRecord, ImageBoardApi } from "../shared/image-board";

const editor = vi.hoisted(() => ({ result: null as unknown as { state: AppState; contentId: string } }));
vi.mock("../renderer/src/pages/ImageEditor", () => ({
  // Exercise the real ContentPage -> App callback without testing pixel editing twice.
  ImageEditor: ({ onSaved }: { onSaved(result: { state: AppState; contentId: string }): Promise<void> }) => (
    <button onClick={() => void onSaved(editor.result)}>完成图片副本保存</button>
  ),
}));

const ISO = "2026-01-01T00:00:00.000Z";
const ORIGINAL = "image-original";
const COPY = "image-copy";
const ORIGINAL_NODE = { id: "node-original", contentId: ORIGINAL, x: 120, y: 150, width: 280, height: 180 };
const COPY_NODE = { id: "node-copy", contentId: COPY, x: 1600, y: 900, width: 320, height: 200 };
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFgAJ/wS4qNwAAAABJRU5ErkJggg==";
function image(id: string): ContentRecord {
  return { id, kind: "image", preview: id, textLength: 0, url: null,
    image: { fileName: `${id}.png`, relativePath: `${id}.png`, width: 640, height: 400, byteSize: 100 },
    coverAsset: null, categoryId: null, source: "manual", createdAt: ISO, updatedAt: ISO, lastUsedAt: ISO };
}
function initialState(): AppState {
  return { revision: 1, activeCanvasId: "source", categories: [], edges: [], contents: { [ORIGINAL]: image(ORIGINAL) },
    canvases: [
      { id: "source", name: "来源画布", parentId: null, frame: null, nodes: [{ ...ORIGINAL_NODE }], createdAt: ISO, viewport: { x: 0, y: 0, zoom: 1 } },
      { id: "other", name: "另一画布", parentId: null, frame: null, nodes: [], createdAt: ISO, viewport: { x: 0, y: 0, zoom: 1 } },
    ] };
}
let current: AppState;
let host: ReturnType<typeof makeHost>;
function makeHost() {
  return {
    loadState: vi.fn(async () => current), onStateChanged: vi.fn(() => () => {}),
    getDesktopSettings: vi.fn(async () => ({ closeBehavior: "float", autoStart: false, autoStartAvailable: false, captureEnabled: true, historyRetentionDays: 30, snapToGrid: false, gridSize: 24 })),
    isMaximized: vi.fn(async () => false), imageUrl: vi.fn(() => PIXEL),
    setActiveCanvas: vi.fn(async (canvasId: string) => (current = { ...current, activeCanvasId: canvasId })),
    setCanvasViewport: vi.fn(async (canvasId: string, viewport: { x: number; y: number; zoom: number }) => (
      current = { ...current, canvases: current.canvases.map((canvas) => canvas.id === canvasId ? { ...canvas, viewport } : canvas) }
    )),
    placeContent: vi.fn(async (contentId: string, canvasId: string, _point: { x: number; y: number }) => {
      current = { ...editor.result.state, revision: 3,
        canvases: editor.result.state.canvases.map((canvas) => canvas.id === canvasId
          ? { ...canvas, nodes: [...canvas.nodes, { ...COPY_NODE, contentId }] } : canvas) };
      return current;
    }),
  };
}
beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () { return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON() {} } as DOMRect; });
  current = initialState();
  host = makeHost();
  window.imageBoard = host as unknown as ImageBoardApi;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openEditor(origin: "canvas" | "library") {
  render(<App />);
  const viewport = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(".canvas-viewport");
    expect(element).toBeTruthy();
    return element!;
  });
  // A real box makes focus/centering observable in jsdom.
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 800 }, clientHeight: { configurable: true, value: 600 },
    getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON() {} }) },
  });
  if (origin === "library") {
    fireEvent.click(within(document.querySelector(".sidebar-nav")!).getByRole("button", { name: "分类库", exact: true }));
    fireEvent.doubleClick(await waitFor(() => {
      const card = document.querySelector<HTMLElement>(`.lib-card[aria-label="图片：${ORIGINAL}.png"]`);
      expect(card).toBeTruthy(); return card!;
    }));
  } else {
    fireEvent.doubleClick(document.querySelector(`[data-node-id="${ORIGINAL_NODE.id}"]`)!);
  }
  fireEvent.click(await screen.findByRole("button", { name: "编辑图像" }));
  return screen.findByRole("button", { name: "完成图片副本保存" });
}
function prepareSavedCopy(activeCanvasId = "source") {
  editor.result = { contentId: COPY, state: { ...current, revision: 2, activeCanvasId,
    contents: { ...current.contents, [COPY]: image(COPY) } } };
}
async function expectCopyRevealed() {
  await waitFor(() => expect(document.querySelector(".page-layer")).toBeNull());
  await waitFor(() => expect(document.querySelector(`[data-node-id="${COPY_NODE.id}"]`)?.classList.contains("selected")).toBe(true));
  expect(document.querySelector(`[data-node-id="${ORIGINAL_NODE.id}"]`)).toBeTruthy();
  expect(current.contents[ORIGINAL]).toEqual(image(ORIGINAL));
  expect(current.canvases.find((canvas) => canvas.id === "source")!.nodes.find((node) => node.id === ORIGINAL_NODE.id)).toEqual(ORIGINAL_NODE);
  // The copy starts far outside the visible board; revealing it must pan to its center.
  await waitFor(() => expect(host.setCanvasViewport).toHaveBeenCalledWith("source", {
    x: 400 - (COPY_NODE.x + COPY_NODE.width / 2), y: 300 - (COPY_NODE.y + COPY_NODE.height / 2), zoom: 1,
  }), { timeout: 3000 });
  expect(screen.getByText("编辑后的图片已放到画布，原图保留")).toBeTruthy();
}

test("saving a canvas image places the copy on its origin even when saved state activates a different canvas, closes the page and reveals it", async () => {
  const save = await openEditor("canvas");
  prepareSavedCopy("other");
  fireEvent.click(save);
  await waitFor(() => expect(host.placeContent).toHaveBeenCalledWith(COPY, "source", {
    x: ORIGINAL_NODE.x + ORIGINAL_NODE.width + 180, y: ORIGINAL_NODE.y + ORIGINAL_NODE.height / 2,
  }));
  await waitFor(() => expect(host.setActiveCanvas).toHaveBeenCalledWith("source"));
  await expectCopyRevealed();
  expect(current.canvases.find((canvas) => canvas.id === "other")!.nodes).toHaveLength(0);
});

test("saving an image opened from the library adds its copy to the active canvas and returns to the board", async () => {
  const save = await openEditor("library");
  prepareSavedCopy();
  fireEvent.click(save);
  await waitFor(() => expect(host.placeContent).toHaveBeenCalledWith(COPY, "source", expect.any(Object)));
  await expectCopyRevealed();
  expect(document.querySelector(".lib-view")).toBeNull();
});

test.each(["canvas", "library"] as const)("a placement failure from %s preserves the saved copy, opens its page, reports the failure and allows reopening from history", async (origin) => {
  const save = await openEditor(origin);
  prepareSavedCopy();
  current = editor.result.state;
  host.placeContent.mockRejectedValueOnce(new Error("磁盘暂不可用"));
  fireEvent.click(save);
  await waitFor(() => expect(within(document.querySelector(".cp-page")!).getByAltText(`${COPY}.png`)).toBeTruthy());
  expect(await screen.findByText("副本已保存，放到画布失败：磁盘暂不可用")).toBeTruthy();
  expect(current.contents[COPY]).toEqual(image(COPY));
  expect(current.contents[ORIGINAL]).toEqual(image(ORIGINAL));
  expect(current.canvases[0].nodes).toEqual([ORIGINAL_NODE]);
  expect(within(document.querySelector(".cp-page")!).getByAltText(`${COPY}.png`)).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".page-layer")).toBeNull());
  if (origin === "library") fireEvent.click(within(document.querySelector(".sidebar-nav")!).getByRole("button", { name: "画布", exact: true }));
  const historyCopy = await waitFor(() => {
    const row = document.querySelector<HTMLElement>(`.hist-item[aria-label="图片：${COPY}.png"]`);
    expect(row).toBeTruthy(); return row!;
  });
  fireEvent.doubleClick(historyCopy);
  await waitFor(() => expect(within(document.querySelector(".cp-page")!).getByAltText(`${COPY}.png`)).toBeTruthy());
});



test("a library save uses the saved state's active canvas even when that canvas has no original placement", async () => {
  const save = await openEditor("library");
  prepareSavedCopy("other");
  fireEvent.click(save);
  await waitFor(() => expect(host.placeContent).toHaveBeenCalledWith(COPY, "other", expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })));
  await waitFor(() => expect(document.querySelector(".page-layer")).toBeNull());
  await waitFor(() => expect(document.querySelector(`[data-node-id="${COPY_NODE.id}"]`)?.classList.contains("selected")).toBe(true));
  expect(current.activeCanvasId).toBe("other");
  expect(current.canvases.find((canvas) => canvas.id === "source")!.nodes).toEqual([ORIGINAL_NODE]);
  expect(current.contents[ORIGINAL]).toEqual(image(ORIGINAL));
  expect(document.querySelector(".lib-view")).toBeNull();
});
