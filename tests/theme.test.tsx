// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CanvasStage, type CanvasStageProps } from "../renderer/src/canvas/CanvasStage";
import { DEFAULT_CANVAS_APPEARANCE, readCanvasAppearance } from "../renderer/src/canvas/canvas-appearance";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  initializeTheme,
  readThemePreference,
  resetThemeForTests,
  resolveTheme,
  saveThemePreference,
  setThemePreference,
  useThemePreference,
} from "../renderer/src/ui/theme";
import type { AppState, CanvasRecord } from "../shared/image-board";

type MediaChangeListener = (event: MediaQueryListEvent) => void;

function createMockMatchMedia(initialMatches = false) {
  let matches = initialMatches;
  const listeners = new Set<MediaChangeListener>();
  const addEventListener = vi.fn((type: string, callback: MediaChangeListener) => {
    if (type === "change") listeners.add(callback);
  });
  const removeEventListener = vi.fn((type: string, callback: MediaChangeListener) => {
    if (type === "change") listeners.delete(callback);
  });

  const mql = {
    media: "(prefers-color-scheme: dark)",
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn((callback: MediaChangeListener) => listeners.add(callback)),
    removeListener: vi.fn((callback: MediaChangeListener) => listeners.delete(callback)),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;

  return {
    mql,
    listeners,
    addEventListener,
    removeEventListener,
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: "(prefers-color-scheme: dark)" } as MediaQueryListEvent;
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

function ThemeProbe() {
  const { preference, resolvedTheme, setPreference } = useThemePreference();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={() => setPreference("light")}>light</button>
      <button type="button" onClick={() => setPreference("dark")}>dark</button>
      <button type="button" onClick={() => setPreference("system")}>system</button>
    </div>
  );
}

beforeEach(() => {
  resetThemeForTests();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore if localStorage is mocked */
  }
});

afterEach(() => {
  cleanup();
  resetThemeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("defaults to system preference and initializes root dataset and colorScheme idempotently", () => {
  const media = createMockMatchMedia(false);
  const matchMediaSpy = vi.fn(() => media.mql);
  vi.stubGlobal("matchMedia", matchMediaSpy);
  const addStorageSpy = vi.spyOn(window, "addEventListener");

  initializeTheme();
  initializeTheme();
  initializeTheme();

  expect(readThemePreference()).toBe(DEFAULT_THEME_PREFERENCE);
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.dataset.themePreference).toBe("system");
  expect(document.documentElement.style.colorScheme).toBe("light");

  // Idempotent: only one media change listener and one window storage listener are registered.
  expect(media.addEventListener).toHaveBeenCalledTimes(1);
  expect(addStorageSpy.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
});

test("useThemePreference updates preference, persists to localStorage, rerenders hook, and updates root dataset", () => {
  const media = createMockMatchMedia(false);
  vi.stubGlobal("matchMedia", () => media.mql);

  const view = render(
    <StrictMode>
      <ThemeProbe />
    </StrictMode>,
  );

  expect(view.getByTestId("preference").textContent).toBe("system");
  expect(view.getByTestId("resolved").textContent).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");

  // StrictMode double-invocation does not register duplicate media listeners.
  expect(media.listeners.size).toBe(1);

  fireEvent.click(view.getByRole("button", { name: "dark" }));
  expect(view.getByTestId("preference").textContent).toBe("dark");
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.dataset.themePreference).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");

  fireEvent.click(view.getByRole("button", { name: "light" }));
  expect(view.getByTestId("preference").textContent).toBe("light");
  expect(view.getByTestId("resolved").textContent).toBe("light");
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

test("system prefers-color-scheme media events update resolved theme only when preference is system", () => {
  const media = createMockMatchMedia(false);
  vi.stubGlobal("matchMedia", () => media.mql);

  const view = render(<ThemeProbe />);
  expect(view.getByTestId("preference").textContent).toBe("system");
  expect(view.getByTestId("resolved").textContent).toBe("light");

  act(() => {
    media.setMatches(true);
  });
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");

  // Lock explicit light preference: system media changes must not override it.
  fireEvent.click(view.getByRole("button", { name: "light" }));
  expect(view.getByTestId("resolved").textContent).toBe("light");

  act(() => {
    media.setMatches(false);
    media.setMatches(true);
  });
  expect(view.getByTestId("preference").textContent).toBe("light");
  expect(view.getByTestId("resolved").textContent).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");

  // Switching back to system adopts the current dark media state immediately.
  fireEvent.click(view.getByRole("button", { name: "system" }));
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("storage events synchronize cross-window theme changes and storage clear/reset", () => {
  const media = createMockMatchMedia(true);
  vi.stubGlobal("matchMedia", () => media.mql);
  saveThemePreference("light");

  const view = render(<ThemeProbe />);
  expect(view.getByTestId("preference").textContent).toBe("light");
  expect(view.getByTestId("resolved").textContent).toBe("light");

  // Cross-window change to dark.
  act(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: THEME_STORAGE_KEY,
        newValue: "dark",
      }),
    );
  });
  expect(view.getByTestId("preference").textContent).toBe("dark");
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");

  // Unrelated storage keys are ignored.
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "other.key",
        newValue: "light",
      }),
    );
  });
  expect(view.getByTestId("preference").textContent).toBe("dark");

  // Storage key removal or clear falls back to system (which resolves to dark via media).
  act(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: null,
        newValue: null,
      }),
    );
  });
  expect(view.getByTestId("preference").textContent).toBe("system");
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("tolerates unavailable localStorage and missing matchMedia without crashing", () => {
  vi.stubGlobal("matchMedia", undefined);
  const brokenStorage = {
    getItem() {
      throw new DOMException("Storage disabled", "SecurityError");
    },
    setItem() {
      throw new DOMException("Storage disabled", "SecurityError");
    },
  } as unknown as Storage;
  vi.spyOn(window, "localStorage", "get").mockReturnValue(brokenStorage);

  expect(() => initializeTheme()).not.toThrow();
  expect(readThemePreference()).toBe("system");
  expect(resolveTheme("system")).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");

  const view = render(<ThemeProbe />);
  expect(view.getByTestId("preference").textContent).toBe("system");
  expect(view.getByTestId("resolved").textContent).toBe("light");

  expect(() => { act(() => { setThemePreference("dark"); }); }).not.toThrow();
  expect(view.getByTestId("preference").textContent).toBe("dark");
  expect(view.getByTestId("resolved").textContent).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

test("CanvasStage uses var(--surface-canvas) for default appearance and preserves legacy custom canvas background", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

  const iso = "2026-01-01T00:00:00.000Z";
  const canvas: CanvasRecord = {
    id: "root",
    name: "主画布",
    parentId: null,
    frame: null,
    createdAt: iso,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
  };
  const state: AppState = {
    revision: 1,
    activeCanvasId: "root",
    canvases: [canvas],
    categories: [],
    contents: {},
    edges: [],
  };

  const baseProps: CanvasStageProps = {
    state,
    canvas,
    contents: state.contents,
    initialViewport: canvas.viewport!,
    busy: false,
    snapToGrid: false,
    gridSize: 24,
    appearance: DEFAULT_CANVAS_APPEARANCE,
    spawnFrom: null,
    enterMotion: "flat",
    selectedNodeIds: [],
    selectedCardId: null,
    selectedEdgeIds: [],
    focusRequest: null,
    onSelectNode: vi.fn(),
    onSelectNodes: vi.fn(),
    onSelectCard: vi.fn(),
    onSelectEdge: vi.fn(),
    onOpenContent: vi.fn(),
    onOpenCanvas: vi.fn(),
    onNodeActions: vi.fn(),
    onCardMenu: vi.fn(),
    onEdgeMenu: vi.fn(),
    onCanvasContextMenu: vi.fn(),
    onNodesMove: vi.fn(),
    onNodesDrop: vi.fn(),
    onCardMove: vi.fn(),
    onEdgeCreate: vi.fn(),
    onViewport: vi.fn(),
    onZoomChange: vi.fn(),
    onInteractionChange: vi.fn(),
  };

  const view = render(<CanvasStage {...baseProps} />);
  const viewport = view.getByRole("region", { name: "画布：主画布" });
  expect(viewport.style.getPropertyValue("--canvas-bg")).toBe("var(--surface-canvas)");
  expect(viewport.style.getPropertyValue("--canvas-pattern")).toBe("var(--canvas-pattern-default)");

  // Legacy record with a custom user-selected background (no explicit backgroundCustomized flag in storage).
  window.localStorage.setItem(
    "quick-image-board.canvas-appearance",
    JSON.stringify({ pattern: "dots", background: "#112233", patternColor: "#39434F", patternOpacity: 0.24 }),
  );
  const legacyCustomAppearance = readCanvasAppearance(window.localStorage);
  expect(legacyCustomAppearance.backgroundCustomized).toBe(true);

  view.rerender(<CanvasStage {...baseProps} appearance={legacyCustomAppearance} />);
  expect(viewport.style.getPropertyValue("--canvas-bg")).toBe("#112233");
  expect(viewport.style.getPropertyValue("--canvas-pattern")).toBe("var(--canvas-pattern-default)");

  act(() => setThemePreference("dark"));
  expect(viewport.style.getPropertyValue("--canvas-bg")).toBe("#112233");

  // Explicit custom ink must survive even when it matches a factory color.
  view.rerender(<CanvasStage {...baseProps} appearance={{ ...legacyCustomAppearance, inkCustomized: true, patternColor: "#202421", patternOpacity: 0.1 }} />);
  expect(viewport.style.getPropertyValue("--canvas-pattern")).toBe("rgba(32, 36, 33, 0.1)");

  // Older customized pattern colors are preserved when their flags are inferred on load.
  window.localStorage.setItem("quick-image-board.canvas-appearance", JSON.stringify({ pattern: "dots", background: "#FBFBFA", patternColor: "#445566", patternOpacity: 0.35 }));
  const legacyCustomInk = readCanvasAppearance(window.localStorage);
  expect(legacyCustomInk.inkCustomized).toBe(true);
  view.rerender(<CanvasStage {...baseProps} appearance={legacyCustomInk} />);
  expect(viewport.style.getPropertyValue("--canvas-bg")).toBe("var(--surface-canvas)");
  expect(viewport.style.getPropertyValue("--canvas-pattern")).toBe("rgba(68, 85, 102, 0.35)");
});