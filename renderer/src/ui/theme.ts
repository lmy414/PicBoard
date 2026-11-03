import { useSyncExternalStore } from "react";
import "./theme.css";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "quick-image-board.theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export interface ThemePreferenceState {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
}

type ThemeSnapshot = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
};

const defaultSnapshot: ThemeSnapshot = {
  preference: DEFAULT_THEME_PREFERENCE,
  resolvedTheme: "light",
};

let snapshot: ThemeSnapshot = defaultSnapshot;
let initialized = false;
let cleanupEnvironment: (() => void) | null = null;
const listeners = new Set<() => void>();

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

function getSafeStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readThemePreference(storage?: Storage | null): ThemePreference {
  const target = getSafeStorage(storage);
  if (!target) return DEFAULT_THEME_PREFERENCE;
  try {
    return normalizeThemePreference(target.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(preference: ThemePreference, storage?: Storage | null): void {
  const normalized = normalizeThemePreference(preference);
  const target = getSafeStorage(storage);
  if (!target) return;
  try {
    target.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    /* Theme changes remain usable if preference storage is unavailable. */
  }
}

function getDarkMediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  try {
    return window.matchMedia(DARK_MEDIA_QUERY);
  } catch {
    return null;
  }
}

export function resolveSystemTheme(): ResolvedTheme {
  return getDarkMediaQueryList()?.matches ? "dark" : "light";
}

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme = resolveSystemTheme(),
): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

function applyThemeToDocument(preference: ThemePreference, resolvedTheme: ResolvedTheme): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;
}

function commitSnapshot(preference: ThemePreference, resolvedTheme: ResolvedTheme): void {
  applyThemeToDocument(preference, resolvedTheme);
  if (snapshot.preference === preference && snapshot.resolvedTheme === resolvedTheme) {
    return;
  }
  snapshot = { preference, resolvedTheme };
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

function attachEnvironmentListeners(): void {
  if (cleanupEnvironment || typeof window === "undefined") return;

  const media = getDarkMediaQueryList();
  const onMediaChange = (event?: MediaQueryListEvent) => {
    if (snapshot.preference !== "system") return;
    const isDark = typeof event?.matches === "boolean" ? event.matches : resolveSystemTheme() === "dark";
    commitSnapshot("system", isDark ? "dark" : "light");
  };

  let removeMedia: (() => void) | null = null;
  if (media) {
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onMediaChange);
      removeMedia = () => media.removeEventListener("change", onMediaChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(onMediaChange);
      removeMedia = () => media.removeListener(onMediaChange);
    }
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const nextPreference =
      event.key === THEME_STORAGE_KEY
        ? normalizeThemePreference(event.newValue)
        : readThemePreference();
    commitSnapshot(nextPreference, resolveTheme(nextPreference));
  };

  window.addEventListener("storage", onStorage);

  cleanupEnvironment = () => {
    removeMedia?.();
    window.removeEventListener("storage", onStorage);
    cleanupEnvironment = null;
  };
}

/** Install once, before createRoot, for both main and tray windows. */
export function initializeTheme(): void {
  if (typeof window === "undefined") return;
  attachEnvironmentListeners();
  const preference = initialized ? snapshot.preference : readThemePreference();
  initialized = true;
  commitSnapshot(preference, resolveTheme(preference));
}

export function setThemePreference(preference: ThemePreference): void {
  const normalized = normalizeThemePreference(preference);
  if (!initialized && typeof window !== "undefined") {
    attachEnvironmentListeners();
    initialized = true;
  }
  saveThemePreference(normalized);
  commitSnapshot(normalized, resolveTheme(normalized));
}

export function resetThemeForTests(): void {
  cleanupEnvironment?.();
  listeners.clear();
  initialized = false;
  snapshot = defaultSnapshot;
  if (typeof document !== "undefined" && document.documentElement) {
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;
    document.documentElement.style.colorScheme = "";
  }
}

function subscribe(listener: () => void): () => void {
  if (!initialized) {
    initializeTheme();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeSnapshot {
  if (!initialized) {
    initializeTheme();
  }
  return snapshot;
}

export function useThemePreference(): ThemePreferenceState {
  const current = useSyncExternalStore(subscribe, getSnapshot, () => defaultSnapshot);
  return {
    preference: current.preference,
    resolvedTheme: current.resolvedTheme,
    setPreference: setThemePreference,
  };
}