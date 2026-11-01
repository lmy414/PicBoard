// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { AppState, ContentRecord } from "../shared/image-board";
import { ContentPage } from "../renderer/src/pages/ContentPage";

Element.prototype.scrollIntoView = function () {};

const NOW = "2026-05-15T04:00:00.000Z";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeState(): AppState {
  const content: ContentRecord = {
    id: "text1",
    kind: "text",
    preview: "",
    textLength: 0,
    url: null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: NOW,
  };
  return { activeCanvasId: "root", canvases: [], categories: [], contents: { text1: content }, edges: [] };
}

function fakeFile(name: string): File {
  return {
    name,
    type: "image/png",
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as unknown as File;
}

function paste(target: Element, payload: { files?: File[]; html?: string }) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: payload.files ?? [],
      getData: (type: string) => (type === "text/html" ? payload.html ?? "" : ""),
    },
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(cleanup);

function mount() {
  const state = makeState();
  let asset = 0;
  const addContentAsset = vi.fn(async () => {
    asset += 1;
    return { assetId: `a${asset}`, mime: "image/png", width: 10, height: 20, byteSize: 4 };
  });
  window.imageBoard = {
    getContentBody: vi.fn(async () => ({ text: "", html: null })),
    updateTextContent: vi.fn(async () => state),
    addContentAsset,
    assetUrl: (contentId: string, assetId: string, variant: string) => `asset://${variant}/${contentId}/${assetId}`,
    openExternalUrl: vi.fn(async () => {}),
  } as unknown as typeof window.imageBoard;
  render(
    <ContentPage
      state={state}
      contentId="text1"
      onState={vi.fn()}
      onClose={vi.fn()}
      onCopy={vi.fn()}
      onQuickActions={vi.fn()}
      onOpenCanvas={vi.fn()}
      onError={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
  return { state, addContentAsset };
}

test("pasting image files uploads and inserts an asset image", async () => {
  const { addContentAsset } = mount();
  await waitFor(() => expect(document.querySelector(".cp-editor-content")).toBeTruthy(), { timeout: 3000 });
  const editor = document.querySelector<HTMLElement>(".cp-editor-content")!;
  editor.focus();
  const event = paste(editor, { files: [fakeFile("shot.png")] });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(document.querySelector('.cp-rt-image[data-asset="text1/a1"]')).toBeTruthy(), { timeout: 3000 });
  expect(addContentAsset).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".cp-rt-image img")?.getAttribute("src")).toBe("asset://full/text1/a1");
});

test("pasted HTML data images are uploaded and rewritten before insertion", async () => {
  const { addContentAsset } = mount();
  await waitFor(() => expect(document.querySelector(".cp-editor-content")).toBeTruthy(), { timeout: 3000 });
  const editor = document.querySelector<HTMLElement>(".cp-editor-content")!;
  editor.focus();
  paste(editor, {
    html: `<p>Hello</p><img src="data:image/png;base64,${PNG}" alt="pasted"><img src="https://example.com/remote.png">`,
  });
  await waitFor(() => expect(document.querySelector(".cp-editor-content")?.textContent).toContain("Hello"), { timeout: 3000 });
  await waitFor(() => expect(document.querySelector('.cp-rt-image[data-asset="text1/a1"]')).toBeTruthy(), { timeout: 3000 });
  expect(addContentAsset).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".cp-editor-content")?.innerHTML).not.toContain("example.com");
});

test("the slash image item opens the hidden picker and inserts the chosen file", async () => {
  const { addContentAsset } = mount();
  await waitFor(() => expect(document.querySelector(".cp-editor-content")).toBeTruthy(), { timeout: 3000 });
  const editor = document.querySelector<HTMLElement>(".cp-editor-content")!;
  editor.focus();
  const paragraph = editor.querySelector("p")!;
  paragraph.textContent = "/";
  await waitFor(() => expect(document.querySelectorAll(".cp-slash-item").length).toBeGreaterThan(0));

  const input = document.querySelector<HTMLInputElement>(".cp-image-input")!;
  expect(input.multiple).toBe(true);
  expect(input.accept).toContain("image/png");
  const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});

  const imageItem = Array.from(document.querySelectorAll<HTMLButtonElement>(".cp-slash-item")).find((item) =>
    item.textContent?.includes("图片"),
  );
  expect(imageItem).toBeTruthy();
  imageItem!.click();
  await waitFor(() => expect(clickSpy).toHaveBeenCalled());

  Object.defineProperty(input, "files", { value: [fakeFile("picked.png")], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() => expect(document.querySelector('.cp-rt-image[data-asset="text1/a1"]')).toBeTruthy(), { timeout: 3000 });
  expect(addContentAsset).toHaveBeenCalledTimes(1);
});
