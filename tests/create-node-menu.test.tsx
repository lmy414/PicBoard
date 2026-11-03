// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../renderer/src/App";
import type {
  AppState,
  CanvasNode,
  CanvasViewport,
  ContentRecord,
  EdgeRecord,
  ImageBoardApi,
  NewContentInput,
} from "../shared/image-board";

const ISO = "2026-01-01T00:00:00.000Z";
const VIEWPORT_RECT = { left: 100, top: 50, width: 800, height: 600 };
const VIEWPORT: CanvasViewport = { x: -200, y: -100, zoom: 2 };
const CREATE_LABELS = ["新建链接节点", "新建富文本节点"];

function content(id: string, kind: ContentRecord["kind"], overrides: Partial<ContentRecord> = {}): ContentRecord {
  return {
    id,
    kind,
    preview: kind === "link" ? "https://example.com" : "第一条笔记",
    textLength: 5,
    url: kind === "link" ? "https://example.com" : null,
    image: null,
    coverAsset: null,
    categoryId: null,
    source: "clipboard",
    createdAt: ISO,
    updatedAt: ISO,
    lastUsedAt: ISO,
    ...overrides,
  };
}

function node(id: string, contentId: string, x = 100, y = 100): CanvasNode {
  return { id, contentId, x, y, width: 280, height: 96 };
}

function makeState(options: {
  viewport?: CanvasViewport;
  nodes?: CanvasNode[];
  contents?: Record<string, ContentRecord>;
  edges?: EdgeRecord[];
  child?: boolean;
} = {}): AppState {
  const nodes = options.nodes ?? [node("n1", "c1")];
  const contents = options.contents ?? { c1: content("c1", "text") };
  const canvases: AppState["canvases"] = [
    { id: "root", name: "主画布", parentId: null, frame: null, nodes, createdAt: ISO, viewport: options.viewport ?? VIEWPORT },
  ];
  if (options.child) {
    canvases.push({
      id: "child",
      name: "子画布",
      parentId: "root",
      frame: { x: 500, y: 200, width: 260, height: 160 },
      nodes: [],
      createdAt: ISO,
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  }
  return {
    revision: 1,
    activeCanvasId: "root",
    canvases,
    categories: [],
    contents,
    edges: options.edges ?? [],
  };
}

function addCreatedNode(base: AppState, kind: NewContentInput["kind"], url?: string) {
  const contentId = `new-${kind === "richText" ? "rich" : kind}`;
  const nodeId = `node-${kind === "richText" ? "rich" : kind}`;
  const created = content(contentId, kind, {
    source: "manual",
    preview: kind === "link" ? url ?? "" : "",
    textLength: 0,
    url: kind === "link" ? url ?? null : null,
  });
  const canvasId = base.activeCanvasId;
  return {
    contentId,
    nodeId,
    state: {
      ...base,
      revision: base.revision + 1,
      contents: { ...base.contents, [contentId]: created },
      canvases: base.canvases.map((canvas) => canvas.id === canvasId
        ? { ...canvas, nodes: [...canvas.nodes, { id: nodeId, contentId, x: 300, y: 200, width: 280, height: 88 }] }
        : canvas),
    } satisfies AppState,
  };
}

interface HostStub {
  loadState: Mock;
  onStateChanged: Mock;
  getDesktopSettings: Mock;
  getContentBody: Mock;
  updateTextContent: Mock;
  setCanvasViewport: Mock;
  openExternalUrl: Mock;
  createContentNode: Mock;
}

let host: HostStub;

function installHost(state: AppState) {
  host = {
    loadState: vi.fn().mockResolvedValue(state),
    onStateChanged: vi.fn(() => () => {}),
    getDesktopSettings: vi.fn().mockResolvedValue({
      closeBehavior: "float",
      autoStart: false,
      autoStartAvailable: false,
      captureEnabled: true,
      historyRetentionDays: 30,
      snapToGrid: false,
      gridSize: 24,
    }),
    getContentBody: vi.fn().mockResolvedValue({ text: "", html: null }),
    updateTextContent: vi.fn().mockResolvedValue(state),
    setCanvasViewport: vi.fn().mockResolvedValue(state),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
    createContentNode: vi.fn(),
  };
  window.imageBoard = host as unknown as ImageBoardApi;
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  // jsdom has no PointerEvent; the plain Event fallback would drop clientX.
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => true;
  document.elementsFromPoint = () => [];
  Element.prototype.scrollIntoView = () => {};
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  installHost(makeState());
});

afterEach(cleanup);

async function renderCanvas(state = makeState()) {
  host.loadState.mockResolvedValue(state);
  render(<App />);
  const viewport = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(".canvas-viewport");
    expect(element).toBeTruthy();
    return element!;
  });
  const rect = {
    ...VIEWPORT_RECT,
    x: VIEWPORT_RECT.left,
    y: VIEWPORT_RECT.top,
    right: VIEWPORT_RECT.left + VIEWPORT_RECT.width,
    bottom: VIEWPORT_RECT.top + VIEWPORT_RECT.height,
    toJSON: () => VIEWPORT_RECT,
  } as DOMRect;
  Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: () => rect });
  return viewport;
}

function mockCreate(state: AppState) {
  host.createContentNode.mockImplementation((_canvasId: string, _center: unknown, input: NewContentInput) =>
    Promise.resolve(addCreatedNode(state, input.kind, input.kind === "link" ? input.url : undefined)));
}

async function openCreateMenu(viewport: HTMLElement) {
  fireEvent.contextMenu(viewport, { clientX: 500, clientY: 350, button: 2 });
  return screen.findByRole("menu");
}

test("blank right click and Shift+A open the same two-item menu without the legacy plain-text option, focused on its first item", async () => {
  const viewport = await renderCanvas();

  const pointerMenu = await openCreateMenu(viewport);
  const pointerItems = within(pointerMenu).getAllByRole("menuitem");
  expect(pointerItems.map((item) => item.textContent)).toEqual(CREATE_LABELS);
  expect(within(pointerMenu).queryByRole("menuitem", { name: "新建文本节点" })).toBeNull();
  expect(document.activeElement).toBe(pointerItems[0]);

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  const keyboardMenu = await screen.findByRole("menu");
  expect(within(keyboardMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(CREATE_LABELS);
  expect(within(keyboardMenu).queryByRole("menuitem", { name: "新建文本节点" })).toBeNull();
});

test("arrow keys move the menu focus, wrap, and Enter activates the focused item", async () => {
  const viewport = await renderCanvas();
  await openCreateMenu(viewport);
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  expect(document.activeElement).toBe(items[0]);

  fireEvent.keyDown(document, { key: "ArrowUp" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);

  fireEvent.keyDown(document, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(host.createContentNode).not.toHaveBeenCalled();
});

test.each([
  ["新建富文本节点", "richText", ".cp-page-richText"],
] as const)("choosing %s creates that kind at the mapped point and opens its page", async (label, kind, pageSelector) => {
  const state = makeState();
  const viewport = await renderCanvas(state);
  mockCreate(state);

  await openCreateMenu(viewport);
  fireEvent.click(screen.getByRole("menuitem", { name: label }));

  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith("root", { x: 300, y: 200 }, { kind }));
  await waitFor(() => expect(document.querySelector(`.page-layer ${pageSelector}`)).toBeTruthy());
  await waitFor(() => {
    const created = document.querySelector<HTMLElement>(`[data-node-id="node-${kind === "richText" ? "rich" : kind}"]`);
    expect(created?.classList.contains("selected")).toBe(true);
  });
});

test("the world point follows the canvas pan and zoom", async () => {
  const state = makeState({ viewport: { x: 120, y: 40, zoom: 0.5 } });
  installHost(state);
  const viewport = await renderCanvas(state);
  mockCreate(state);

  await openCreateMenu(viewport);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建富文本节点" }));
  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith("root", { x: 560, y: 520 }, { kind: "richText" }));
});

test("Shift+A uses the pointer while it is inside the canvas", async () => {
  const state = makeState();
  await renderCanvas(state);
  mockCreate(state);

  fireEvent.pointerMove(document.body, { clientX: 700, clientY: 400 });
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  await screen.findByRole("menu");
  fireEvent.click(screen.getByRole("menuitem", { name: "新建富文本节点" }));
  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith("root", { x: 400, y: 225 }, { kind: "richText" }));
});

test("Shift+A falls back to the viewport center when the pointer is outside it", async () => {
  const state = makeState();
  await renderCanvas(state);
  mockCreate(state);

  fireEvent.pointerMove(document.body, { clientX: 10, clientY: 10 });
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  await screen.findByRole("menu");
  fireEvent.click(screen.getByRole("menuitem", { name: "新建富文本节点" }));
  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith("root", { x: 300, y: 200 }, { kind: "richText" }));
});

test("Shift+A ignores editable targets, repeated keys, modifiers, open menus and a full page", async () => {
  const viewport = await renderCanvas();

  const input = document.querySelector<HTMLInputElement>(".sidebar-search input")!;
  fireEvent.keyDown(input, { key: "a", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();

  const prose = document.createElement("div");
  prose.className = "ProseMirror";
  prose.contentEditable = "true";
  document.body.append(prose);
  fireEvent.keyDown(prose, { key: "a", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  prose.remove();

  fireEvent.keyDown(document, { key: "a", shiftKey: true, repeat: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "a", shiftKey: true, isComposing: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "a", shiftKey: true, ctrlKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "a", shiftKey: true, metaKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "a", shiftKey: true, altKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "a" });
  expect(screen.queryByRole("menu")).toBeNull();

  await openCreateMenu(viewport);
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  fireEvent.doubleClick(document.querySelector<HTMLElement>(".canvas-node")!);
  await waitFor(() => expect(document.querySelector(".page-layer")).toBeTruthy(), { timeout: 2000 });
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("node, card, edge and mini-map right clicks never open the create menu", async () => {
  const state = makeState({
    nodes: [node("n1", "c1"), node("n2", "c2", 420, 100)],
    contents: { c1: content("c1", "text"), c2: content("c2", "link") },
    edges: [{ id: "e1", fromNode: "n1", toNode: "n2", createdAt: ISO }],
    child: true,
  });
  installHost(state);
  await renderCanvas(state);

  fireEvent.contextMenu(document.querySelector<HTMLElement>(".canvas-node")!, { clientX: 300, clientY: 300 });
  await waitFor(() => expect(document.querySelector(".content-actions")).toBeTruthy());
  expect(screen.queryByRole("menuitem", { name: "新建文本节点" })).toBeNull();
  expect(host.createContentNode).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".content-actions")).toBeNull());

  fireEvent.contextMenu(document.querySelector<HTMLElement>(".edge-hit")!, { clientX: 250, clientY: 250 });
  const edgeMenu = await screen.findByRole("menu");
  expect(within(edgeMenu).getAllByRole("menuitem").length).toBeGreaterThan(0);
  expect(within(edgeMenu).queryByRole("menuitem", { name: "新建文本节点" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  fireEvent.contextMenu(document.querySelector<HTMLElement>(".canvas-node-card")!, { clientX: 600, clientY: 250 });
  const cardMenu = await screen.findByRole("menu");
  expect(within(cardMenu).getAllByRole("menuitem").length).toBeGreaterThan(0);
  expect(within(cardMenu).queryByRole("menuitem", { name: "新建文本节点" })).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  const miniMap = document.querySelector<HTMLElement>(".mini-map");
  expect(miniMap).toBeTruthy();
  fireEvent.contextMenu(miniMap!, { clientX: 800, clientY: 500 });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(host.createContentNode).not.toHaveBeenCalled();
});

test("link creation keeps invalid input editable and only creates once the URL is valid", async () => {
  const state = makeState();
  const viewport = await renderCanvas(state);
  mockCreate(state);

  await openCreateMenu(viewport);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建链接节点" }));
  const dialog = await screen.findByRole("alertdialog");
  const input = within(dialog).getByRole("textbox") as HTMLInputElement;
  expect(input.value).toBe("https://");

  fireEvent.change(input, { target: { value: "example.com/page" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  expect(input.value).toBe("example.com/page");
  expect(host.createContentNode).not.toHaveBeenCalled();

  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.keyDown(document, { key: "a", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.change(input, { target: { value: "https://example.com/page" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith(
    "root",
    { x: 300, y: 200 },
    { kind: "link", url: "https://example.com/page" },
  ));
  await waitFor(() => expect(document.querySelector(".page-layer .cp-page-link")).toBeTruthy());
});

test("cancelling the link prompt and a rejected create leave no page or node behind", async () => {
  const state = makeState();
  const viewport = await renderCanvas(state);

  await openCreateMenu(viewport);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建链接节点" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(host.createContentNode).not.toHaveBeenCalled();
  expect(document.querySelector(".page-layer")).toBeNull();

  host.createContentNode.mockRejectedValueOnce(new Error("磁盘已满"));
  await openCreateMenu(viewport);
  fireEvent.click(screen.getByRole("menuitem", { name: "新建富文本节点" }));
  expect(await screen.findByText("磁盘已满")).toBeTruthy();
  await waitFor(() => expect(document.querySelector(".busy-chip")).toBeNull());
  expect(document.querySelector(".page-layer")).toBeNull();
  expect(document.querySelector('[data-node-id="node-rich"]')).toBeNull();
});


test("the bottom dock creates a rich-text node at the board center with no plain-text action", async () => {
  const state = makeState();
  await renderCanvas(state);
  mockCreate(state);
  const dock = screen.getByRole("toolbar", { name: "画板工具" });
  expect(within(dock).queryByRole("button", { name: "新建文本节点" })).toBeNull();
  fireEvent.click(within(dock).getByRole("button", { name: "新建富文本节点" }));
  await waitFor(() => expect(host.createContentNode).toHaveBeenCalledWith("root", { x: 300, y: 200 }, { kind: "richText" }));
  await waitFor(() => expect(document.querySelector(".page-layer .cp-page-richText")).toBeTruthy());
});
