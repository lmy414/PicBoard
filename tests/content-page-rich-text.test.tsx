// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { AppState, ContentBody, ContentKind, ContentRecord } from "../shared/image-board";
import { ContentPage } from "../renderer/src/pages/ContentPage";

Element.prototype.scrollIntoView = function () {};

const NOW = "2026-05-15T04:00:00.000Z";

type RangeGeometry = {
  getClientRects?: () => DOMRectList;
  getBoundingClientRect?: () => DOMRect;
};

/**
 * jsdom has no Range geometry. ProseMirror computes caret coordinates while
 * scrolling a selection after an edit, so restore the missing CSSOM methods
 * for the duration of a test and put the prototype back afterwards.
 */
function installRangeGeometry(): () => void {
  const proto = Range.prototype as unknown as RangeGeometry;
  const clientRects = proto.getClientRects;
  const boundingRect = proto.getBoundingClientRect;
  const zero = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  } as unknown as DOMRect;
  proto.getClientRects = () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect = () => zero;
  return () => {
    if (clientRects) proto.getClientRects = clientRects;
    else delete proto.getClientRects;
    if (boundingRect) proto.getBoundingClientRect = boundingRect;
    else delete proto.getBoundingClientRect;
  };
}

let restoreRangeGeometry: (() => void) | null = null;

beforeEach(() => {
  restoreRangeGeometry = installRangeGeometry();
});

function makeContent(kind: ContentKind): ContentRecord {
  return {
    id: "text1",
    kind,
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
}

function makeState(kind: ContentKind): AppState {
  return {
    revision: 1,
    activeCanvasId: "root",
    canvases: [],
    categories: [],
    contents: { text1: makeContent(kind) },
    edges: [],
  };
}

function pasteText(target: HTMLElement, text: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (type: string) => (type === "text/plain" || type === "Text" ? text : ""),
    },
  });
  fireEvent(target, event);
}

function mountPage(kind: ContentKind, body: ContentBody) {
  const initial = makeState(kind);
  const updates: ContentBody[] = [];
  const callbacks = {
    onClose: vi.fn(),
    onCopy: vi.fn(),
    onQuickActions: vi.fn(),
    onOpenCanvas: vi.fn(),
    onError: vi.fn(),
    onNotice: vi.fn(),
  };
  window.imageBoard = {
    getContentBody: vi.fn(async () => body),
    // The real host derives the kind from the HTML field; mirror that so the
    // page sees the same text/richText transitions after a save.
    updateTextContent: vi.fn(async (_contentId: string, next: ContentBody): Promise<AppState> => {
      updates.push(next);
      return {
        ...initial,
        contents: {
          text1: {
            ...initial.contents.text1,
            kind: next.html === null ? "text" : "richText",
            preview: next.text,
            textLength: next.text.length,
          },
        },
      };
    }),
    openExternalUrl: vi.fn(async () => {}),
  } as unknown as typeof window.imageBoard;

  let pushState: ((next: AppState) => void) | null = null;

  function Harness() {
    const [state, setState] = useState<AppState>(initial);
    pushState = setState;
    return (
      <ContentPage
        state={state}
        contentId="text1"
        onState={setState}
        onClose={callbacks.onClose}
        onCopy={callbacks.onCopy}
        onQuickActions={callbacks.onQuickActions}
        onOpenCanvas={callbacks.onOpenCanvas}
        onError={callbacks.onError}
        onNotice={callbacks.onNotice}
      />
    );
  }

  const view = render(<Harness />);
  return {
    ...view,
    updates,
    callbacks,
    applyState(next: AppState) {
      act(() => pushState?.(next));
    },
  };
}

async function waitForEditor(): Promise<HTMLElement> {
  let element: HTMLElement | null = null;
  await waitFor(
    () => {
      element = document.querySelector<HTMLElement>(".cp-editor-content");
      expect(element).not.toBeNull();
    },
    { timeout: 3000 },
  );
  if (!element) throw new Error("editor not mounted");
  return element;
}

async function waitForBodyFocus(editor: HTMLElement): Promise<void> {
  await waitFor(() => expect(document.activeElement).toBe(editor), { timeout: 3000 });
}

afterEach(() => {
  cleanup();
  restoreRangeGeometry?.();
  restoreRangeGeometry = null;
});

test("typing plain text into empty rich content saves HTML", async () => {
  const { updates, callbacks } = mountPage("richText", { text: "", html: "<p></p>" });
  const editor = await waitForEditor();
  await waitForBodyFocus(editor);

  pasteText(editor, "普通文字");
  await waitFor(() => expect(editor.textContent).toBe("普通文字"));
  await waitFor(
    () => {
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)!.html).not.toBeNull();
    },
    { timeout: 3000 },
  );

  const saved = updates.at(-1)!;
  expect(saved.text).toBe("普通文字");
  expect(saved.html).not.toBeNull();
  expect(saved.html).toContain("普通文字");
  expect(saved.html).toContain("<p>");
  expect(callbacks.onError).not.toHaveBeenCalled();
});

test("the first load puts the caret at the end and later data updates keep it there", async () => {
  const { updates, applyState } = mountPage("text", { text: "abcd", html: null });
  const editor = await waitForEditor();
  await waitForBodyFocus(editor);

  // A paste lands at the caret; appending proves the initial caret is at the end.
  pasteText(editor, "e");
  await waitFor(() => expect(editor.textContent).toBe("abcde"));

  // A parent state update (as delivered by the host after a save) must not
  // rebuild the editor or move the caret back to the start.
  applyState(makeState("text"));
  await waitFor(() => expect(document.activeElement).toBe(editor));

  pasteText(editor, "f");
  await waitFor(() => expect(editor.textContent).toBe("abcdef"));
  await waitFor(
    () => expect(updates.at(-1)).toEqual({ text: "abcdef", html: null }),
    { timeout: 3000 },
  );
  expect(updates.at(-1)).toEqual({ text: "abcdef", html: null });
});

test("formatting plain text saves real strong markup and stays rich after it is removed", async () => {
  const { updates } = mountPage("text", { text: "加粗", html: null });
  const editor = await waitForEditor();
  await waitForBodyFocus(editor);

  fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
  fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
  await waitFor(() => expect(editor.querySelector("strong")?.textContent).toBe("加粗"));
  await waitFor(
    () => expect(updates.at(-1)?.html).toContain("<strong>加粗</strong>"),
    { timeout: 3000 },
  );

  const formatted = updates.at(-1)!;
  expect(formatted.text).toBe("加粗");
  expect(formatted.html).toContain("<strong>加粗</strong>");

  // The host has now promoted this content to richText; removing the mark must
  // keep sending HTML instead of demoting it back to plain text.
  await waitFor(() => expect(document.querySelector(".cp-page-richText")).not.toBeNull(), { timeout: 3000 });
  const countBeforeClear = updates.length;
  fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
  fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
  await waitFor(() => expect(editor.querySelector("strong")).toBeNull());
  await waitFor(
    () => {
      expect(updates.length).toBeGreaterThan(countBeforeClear);
      expect(updates.at(-1)!.html).not.toBeNull();
    },
    { timeout: 3000 },
  );

  const cleared = updates.at(-1)!;
  expect(cleared.text).toBe("加粗");
  expect(cleared.html).not.toBeNull();
  expect(cleared.html).not.toContain("<strong>");
});

test("removing formatting from rich content still saves HTML", async () => {
  const { updates } = mountPage("richText", { text: "旧", html: "<p><strong>旧</strong></p>" });
  const editor = await waitForEditor();
  await waitForBodyFocus(editor);

  fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
  fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
  await waitFor(() => expect(editor.querySelector("strong")).toBeNull());
  await waitFor(
    () => {
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)!.html).not.toBeNull();
      expect(updates.at(-1)!.html).not.toContain("<strong>");
    },
    { timeout: 3000 },
  );

  const saved = updates.at(-1)!;
  expect(saved.text).toBe("旧");
  expect(saved.html).not.toBeNull();
  expect(saved.html).not.toContain("<strong>");
});

test("unmounting a cleared rich page still saves HTML", async () => {
  const { updates, unmount } = mountPage("richText", { text: "旧", html: "<p><strong>旧</strong></p>" });
  const editor = await waitForEditor();
  await waitForBodyFocus(editor);

  fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
  fireEvent.keyDown(editor, { key: "Backspace" });
  // Unmount before the debounced save, so the cleanup snapshot is exercised.
  unmount();

  await waitFor(() => expect(updates.length).toBeGreaterThan(0), { timeout: 3000 });
  const saved = updates.at(-1)!;
  expect(saved.text).toBe("");
  expect(saved.html).not.toBeNull();
});
