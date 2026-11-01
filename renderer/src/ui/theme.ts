/**
 * Renderer theme preference.
 *
 * `clean` is the default calm flat look; `neumorphism` is the soft-UI look.
 * The choice lives in localStorage so the main window and the tray flyout
 * (same origin) stay on the same theme, and it is mirrored onto
 * `<html data-theme>` for CSS.
 */
import { useSyncExternalStore } from "react";

export type ThemeId = "clean" | "neumorphism";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  description: string;
}

export const THEME_STORAGE_KEY = "quick-image-board.theme";
export const DEFAULT_THEME: ThemeId = "clean";

export const THEMES: readonly ThemeOption[] = [
  { id: "clean", label: "简洁", description: "平面浅色界面，细边框与轻阴影，适合长时间浏览。" },
  { id: "neumorphism", label: "新拟物", description: "柔和的凹凸光影，控件像从底色中浮出。" },
] as const;

/** Duration of the crossfade driven by the `theme-switching` class. */
export const THEME_SWITCH_MS = 320;

const THEME_IDS = new Set<string>(THEMES.map((option) => option.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Stored preference, falling back to `clean` for missing or invalid values. */
export function readTheme(storage: Storage | null = defaultStorage()): ThemeId {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

let currentTheme: ThemeId | null = null;
const listeners = new Set<() => void>();

function getTheme(): ThemeId {
  if (currentTheme === null) currentTheme = readTheme();
  return currentTheme;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

let switchTimer: number | undefined;

/**
 * Mirror a theme onto the document root. `animate` crossfades the token swap
 * with the `theme-switching` class (skipped for reduced motion and on the
 * first paint, when no previous theme is set yet).
 */
export function applyTheme(id: ThemeId, options: { animate?: boolean } = {}): void {
  currentTheme = id;
  if (typeof document === "undefined") {
    emit();
    return;
  }
  const root = document.documentElement;
  const changed = root.dataset.theme !== id;
  const animate = options.animate === true && changed && root.dataset.theme !== undefined && !prefersReducedMotion();
  if (animate) {
    root.classList.add("theme-switching");
    // Commit the transition baseline before the token swap.
    void root.offsetWidth;
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => root.classList.remove("theme-switching"), THEME_SWITCH_MS);
  } else {
    root.classList.remove("theme-switching");
  }
  root.dataset.theme = id;
  emit();
}

/** Persist and apply a theme; this is what the picker calls. */
export function setTheme(id: ThemeId): void {
  if (!isThemeId(id)) return;
  try {
    defaultStorage()?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* local preference storage is optional */
  }
  applyTheme(id, { animate: true });
}

/**
 * Keep windows in sync through the `storage` event (both Tauri surfaces share
 * the origin's localStorage). Returns an unsubscribe function.
 */
export function startThemeSync(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const next = readTheme();
    if (next === getTheme() && document.documentElement.dataset.theme === next) return;
    applyTheme(next, { animate: true });
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export interface UseThemeResult {
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
}

export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  return { theme, setTheme };
}
