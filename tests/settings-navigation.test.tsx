// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { AppState, DesktopSettings } from "../shared/image-board";
import { DEFAULT_CANVAS_APPEARANCE } from "../renderer/src/canvas/canvas-appearance";
import { SETTINGS_SECTIONS, SettingsNavigation, SettingsPage } from "../renderer/src/ui/SettingsPage";
import type { SettingsPageProps } from "../renderer/src/ui/SettingsPage";

const desktop: DesktopSettings = {
  closeBehavior: "tray", autoStart: false, autoStartAvailable: true,
  captureEnabled: true, historyRetentionDays: 30, snapToGrid: false, gridSize: 24,
};

function props(): Omit<SettingsPageProps, "section"> {
  const state: AppState = { activeCanvasId: "root", canvases: [], contents: {}, edges: [], categories: [{ id: "ideas", name: "想法", createdAt: "2026-05-15T04:00:00.000Z" }] };
  return {
    state,
    pathSettings: { filePath: "C:/PicBoard" },
    desktopSettings: desktop,
    canvasAppearance: { ...DEFAULT_CANVAS_APPEARANCE },
    onPathSettingsChange: vi.fn(), onCanvasAppearanceChange: vi.fn(),
    onDesktopSettingsChange: vi.fn(), onAddCategory: vi.fn(async () => true),
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.imageBoard = {
    getDesktopSettings: vi.fn(async () => desktop),
    setDesktopSettings: vi.fn(async (patch) => ({ ...desktop, ...patch })),
    getImageAssociation: vi.fn(async () => ({ available: true, registered: false })),
    configureImageAssociation: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => "D:/Pictures"),
    listPlugins: vi.fn(async () => ({ directory: "C:/PicBoard/plugins", plugins: [], errors: [] })),
  } as unknown as typeof window.imageBoard;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const name of ["--surface-canvas", "--canvas-pattern-default"]) document.documentElement.style.removeProperty(name);
});

test("settings navigation lists all projects and highlights only the controlled selection", () => {
  const onSectionChange = vi.fn();
  const view = render(<SettingsNavigation section="canvas" query="" onSectionChange={onSectionChange} />);
  const nav = within(view.getByRole("navigation", { name: "设置项目" }));
  expect(nav.getAllByRole("button").map((button) => button.textContent)).toEqual(SETTINGS_SECTIONS.map((section) => section.label));
  expect(nav.getAllByRole("button")).toHaveLength(8);
  expect(nav.getByRole("button", { name: "画布" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(nav.getByRole("button", { name: "默认图片打开器" }));
  expect(onSectionChange).toHaveBeenCalledWith("images");
  view.rerender(<SettingsNavigation section="images" query="" onSectionChange={onSectionChange} />);
  expect(nav.getByRole("button", { name: "默认图片打开器" }).getAttribute("aria-current")).toBe("page");
  expect(nav.getByRole("button", { name: "画布" }).getAttribute("aria-current")).toBeNull();
});

test.each([
  ["  ", SETTINGS_SECTIONS.length], ["CLIPBOARD", 1], ["文件夹", 1], ["默认 图片", 1], ["深色", 1],
])("settings navigation searches labels and keywords: %s", (query, count) => {
  const view = render(<SettingsNavigation section="canvas" query={query} onSectionChange={vi.fn()} />);
  expect(view.getAllByRole("button")).toHaveLength(count);
});

test("no search result leaves the selected settings page intact", () => {
  const onSectionChange = vi.fn();
  const view = render(<><SettingsNavigation section="clipboard" query="没有这样的项目" onSectionChange={onSectionChange} /><SettingsPage {...props()} section="clipboard" /></>);
  const nav = within(view.getByRole("navigation", { name: "设置项目" }));
  expect(nav.queryAllByRole("button")).toHaveLength(0);
  expect(nav.getByRole("status").textContent).toContain("没有匹配");
  expect(view.getByRole("heading", { level: 1, name: "剪贴板" })).toBeTruthy();
  expect(onSectionChange).not.toHaveBeenCalled();
});

test.each(SETTINGS_SECTIONS)("the $id page mounts only its selected settings card", async ({ id, label }) => {
  const view = render(<SettingsPage {...props()} section={id} />);
  expect(view.getByRole("heading", { level: 1, name: label })).toBeTruthy();
  expect(view.getByText("在左侧选择设置项目，修改即时生效。")).toBeTruthy();
  expect(view.container.querySelectorAll(".settings-page > .settings-section")).toHaveLength(1);
  if (id === "images") await waitFor(() => expect(window.imageBoard.getImageAssociation).toHaveBeenCalledTimes(1));
  if (id === "window") await waitFor(() => expect(window.imageBoard.getDesktopSettings).toHaveBeenCalledTimes(1));
  if (id === "plugins") await waitFor(() => expect(window.imageBoard.listPlugins).toHaveBeenCalledTimes(1));
  if (id !== "images") expect(window.imageBoard.getImageAssociation).not.toHaveBeenCalled();
  if (id !== "window") expect(window.imageBoard.getDesktopSettings).not.toHaveBeenCalled();
  if (id !== "plugins") expect(window.imageBoard.listPlugins).not.toHaveBeenCalled();
});

test("canvas settings retain appearance and grid callbacks", async () => {
  const callbacks = props();
  const view = render(<SettingsPage {...callbacks} section="canvas" />);
  fireEvent.click(view.getByRole("button", { name: "网格线", exact: true }));
  expect(callbacks.onCanvasAppearanceChange).toHaveBeenCalledWith({ pattern: "lines" });
  fireEvent.click(view.getByRole("button", { name: "背景纸白", exact: true }));
  expect(callbacks.onCanvasAppearanceChange).toHaveBeenCalledWith({ background: "#FBFBFA" });
  fireEvent.click(view.getByRole("checkbox", { name: /网格对齐/ }));
  expect(callbacks.onDesktopSettingsChange).toHaveBeenCalledWith({ snapToGrid: true });
  fireEvent.click(view.getByRole("button", { name: "24", exact: true }));
  fireEvent.mouseDown(await view.findByRole("option", { name: "32", exact: true }));
  expect(callbacks.onDesktopSettingsChange).toHaveBeenCalledWith({ gridSize: 32 });
});

test("switching pages removes the previous card and closes its popover", async () => {
  const callbacks = props();
  const view = render(<SettingsPage {...callbacks} section="canvas" />);
  fireEvent.click(view.getByRole("button", { name: "24", exact: true }));
  await view.findByRole("listbox", { name: "网格间距" });
  view.rerender(<SettingsPage {...callbacks} section="clipboard" />);
  expect(view.queryByRole("listbox")).toBeNull();
  expect(view.queryByRole("group", { name: "画布图案" })).toBeNull();
  fireEvent.click(view.getByRole("checkbox", { name: /后台记录剪贴板/ }));
  expect(callbacks.onDesktopSettingsChange).toHaveBeenCalledWith({ captureEnabled: false });
  fireEvent.click(view.getByRole("button", { name: "30 天", exact: true }));
  fireEvent.mouseDown(await view.findByRole("option", { name: "7 天", exact: true }));
  expect(callbacks.onDesktopSettingsChange).toHaveBeenCalledWith({ historyRetentionDays: 7 });
});

test("storage preferences preserve manual path edits and the native folder picker", async () => {
  const callbacks = props();
  const view = render(<SettingsPage {...callbacks} section="storage" />);
  fireEvent.change(view.getByRole("textbox", { name: /文件路径/ }), { target: { value: "D:/Board" } });
  expect(callbacks.onPathSettingsChange).toHaveBeenCalledWith({ filePath: "D:/Board" });
  fireEvent.click(view.getByRole("button", { name: "选择文件夹" }));
  await waitFor(() => expect(callbacks.onPathSettingsChange).toHaveBeenCalledWith({ filePath: "D:/Pictures" }));
  expect(window.imageBoard.pickDirectory).toHaveBeenCalledTimes(1);
});

test("category management preserves its list and add callback", () => {
  const callbacks = props();
  const view = render(<SettingsPage {...callbacks} section="categories" />);
  expect(view.getByText("想法")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /新建分类/ }));
  expect(callbacks.onAddCategory).toHaveBeenCalledTimes(1);
});

test("the image opener registers only after the user clicks its action", async () => {
  const view = render(<SettingsPage {...props()} section="images" />);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "设为默认图片应用" });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(window.imageBoard.configureImageAssociation).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(window.imageBoard.configureImageAssociation).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.getByRole("status").textContent).toContain("Windows 默认应用设置"));
});

test("appearance changes update the selected theme and the application surface", () => {
  const view = render(<SettingsPage {...props()} section="appearance" />);
  fireEvent.click(view.getByRole("radio", { name: "浅色", exact: true }));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(view.getByRole("radio", { name: "黑夜", exact: true }));
  expect(view.getByRole<HTMLInputElement>("radio", { name: "黑夜", exact: true }).checked).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(view.getByRole("radio", { name: "跟随系统", exact: true }));
  expect(view.getByRole<HTMLInputElement>("radio", { name: "跟随系统", exact: true }).checked).toBe(true);
});

test("canvas controls show actual theme defaults and preserve customized colors", () => {
  document.documentElement.style.setProperty("--surface-canvas", "#151d18");
  document.documentElement.style.setProperty("--canvas-pattern-default", "rgba(200, 210, 202, 0.16)");
  const callbacks = props();
  const view = render(<SettingsPage {...callbacks} section="canvas" />);
  expect(view.getByRole("button", { name: "#151d18", exact: true })).toBeTruthy();
  expect(view.getByRole("button", { name: "#c8d2ca", exact: true })).toBeTruthy();
  expect(view.getByRole<HTMLInputElement>("slider", { name: "图案浓度" }).value).toBe("0.16");
  fireEvent.change(view.getByRole("slider", { name: "图案浓度" }), { target: { value: "0.28" } });
  expect(callbacks.onCanvasAppearanceChange).toHaveBeenCalledWith({ patternOpacity: 0.28, patternColor: "#c8d2ca" });

  view.rerender(<SettingsPage {...callbacks} section="canvas" canvasAppearance={{ ...callbacks.canvasAppearance, background: "#112233", patternColor: "#445566", patternOpacity: 0.34, backgroundCustomized: true, inkCustomized: true }} />);
  expect(view.getByRole("button", { name: "#112233", exact: true })).toBeTruthy();
  expect(view.getByRole("button", { name: "#445566", exact: true })).toBeTruthy();
  expect(view.getByRole<HTMLInputElement>("slider", { name: "图案浓度" }).value).toBe("0.34");
});
