// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { AppState, ContentRecord } from "../shared/image-board";
import { ContentPage } from "../renderer/src/pages/ContentPage";

Element.prototype.scrollIntoView = function () {};

const NOW = "2026-05-15T04:00:00.000Z";

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
  return {
    activeCanvasId: "root",
    canvases: [],
    categories: [],
    contents: { text1: content },
    edges: [],
  };
}

function mountPage(state: AppState, onClose = vi.fn()) {
  window.imageBoard = {
    getContentBody: vi.fn(async () => ({ text: "", html: null })),
    updateTextContent: vi.fn(async () => state),
    openExternalUrl: vi.fn(async () => {}),
  } as unknown as typeof window.imageBoard;
  render(
    <ContentPage
      state={state}
      contentId="text1"
      onState={vi.fn()}
      onClose={onClose}
      onCopy={vi.fn()}
      onQuickActions={vi.fn()}
      onOpenCanvas={vi.fn()}
      onError={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
  return onClose;
}

function editorElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".cp-editor-content");
  if (!element) throw new Error("editor not mounted");
  return element;
}

function press(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function openSlashMenu() {
  await waitFor(() => editorElement(), { timeout: 3000 });
  const paragraph = editorElement().querySelector("p");
  if (!paragraph) throw new Error("paragraph not mounted");
  paragraph.textContent = "/";
  await waitFor(() => expect(document.querySelector(".cp-slash-menu")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll(".cp-slash-item").length).toBeGreaterThan(0));
}

afterEach(cleanup);

test("Esc closes the page even when the keydown is already default-prevented", async () => {
  const state = makeState();
  const onClose = mountPage(state);
  await waitFor(() => editorElement(), { timeout: 3000 });

  // A lower layer may have called preventDefault before the page sees Escape.
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  escape.preventDefault();
  expect(escape.defaultPrevented).toBe(true);
  editorElement().dispatchEvent(escape);

  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("Esc closes the page after a slash-menu item was inserted", async () => {
  const state = makeState();
  const onClose = mountPage(state);
  await openSlashMenu();

  const editor = editorElement();
  press(editor, "ArrowDown");
  press(editor, "Enter");
  await waitFor(() => expect(document.querySelector(".cp-slash-menu")).toBeNull());
  expect(editor.innerHTML).toContain("<h1");

  press(editor, "Escape");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(window.imageBoard.updateTextContent).toHaveBeenCalled();
});

test("Esc closes an open slash menu before the page", async () => {
  const state = makeState();
  const onClose = mountPage(state);
  await openSlashMenu();

  const editor = editorElement();
  press(editor, "Escape");
  await waitFor(() => expect(document.querySelector(".cp-slash-menu")).toBeNull());
  expect(onClose).not.toHaveBeenCalled();

  press(editor, "Escape");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("Esc defers to an open content action layer and canvas context menu", async () => {
  const state = makeState();
  const onClose = mountPage(state);
  await waitFor(() => editorElement(), { timeout: 3000 });

  const actions = document.createElement("div");
  actions.className = "content-actions";
  document.body.append(actions);
  press(editorElement(), "Escape");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(onClose).not.toHaveBeenCalled();

  actions.className = "";
  actions.setAttribute("data-esc-layer", "");
  press(editorElement(), "Escape");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(onClose).not.toHaveBeenCalled();

  actions.remove();
  press(editorElement(), "Escape");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
