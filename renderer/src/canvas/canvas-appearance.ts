/** Canvas surface look: pattern, background and pattern ink. Local renderer preference. */
import type { ThemeId } from "../ui/theme";

export type CanvasPattern = "dots" | "lines" | "none";

export interface CanvasAppearance {
  pattern: CanvasPattern;
  /** Six-digit hex background. */
  background: string;
  /** Six-digit hex pattern ink. */
  patternColor: string;
  /** 0..1 ink alpha. */
  patternOpacity: number;
  /** True once the user picked a background; otherwise it follows the theme. */
  backgroundCustomized: boolean;
  /** True once the user picked an ink color/opacity; otherwise it follows the theme. */
  inkCustomized: boolean;
}

export const CANVAS_APPEARANCE_KEY = "quick-image-board.canvas-appearance";

export type CanvasThemeDefaults = Pick<CanvasAppearance, "background" | "patternColor" | "patternOpacity">;

/** Per-theme canvas defaults: clean is paper-white, neumorphism is the old fog grey. */
export const CANVAS_THEME_DEFAULTS: Record<ThemeId, CanvasThemeDefaults> = {
  clean: { background: "#FBFBFA", patternColor: "#37352F", patternOpacity: 0.22 },
  neumorphism: { background: "#E8ECF1", patternColor: "#39434F", patternOpacity: 0.24 },
};

/** Full appearance for a theme (dots on, theme default colours). */
export function canvasAppearanceDefaults(theme: ThemeId = "clean"): CanvasAppearance {
  return {
    pattern: "dots",
    ...CANVAS_THEME_DEFAULTS[theme],
    backgroundCustomized: false,
    inkCustomized: false,
  };
}

export const DEFAULT_CANVAS_APPEARANCE: CanvasAppearance = canvasAppearanceDefaults("clean");

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Backgrounds that ever shipped as theme defaults; a stored one of these means "not customized". */
const THEME_DEFAULT_BACKGROUNDS = new Set([...Object.values(CANVAS_THEME_DEFAULTS).map((value) => value.background.toUpperCase())]);
const THEME_DEFAULT_INKS = new Set([...Object.values(CANVAS_THEME_DEFAULTS).map((value) => value.patternColor.toUpperCase())]);
const THEME_DEFAULT_OPACITIES = [...Object.values(CANVAS_THEME_DEFAULTS).map((value) => value.patternOpacity)];

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toUpperCase() : fallback;
}

function normalizeOpacity(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, number));
}

export function readCanvasAppearance(storage: Storage, theme: ThemeId = "clean"): CanvasAppearance {
  const defaults = canvasAppearanceDefaults(theme);
  try {
    const raw = storage.getItem(CANVAS_APPEARANCE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<CanvasAppearance> : {};
    const pattern = value.pattern === "lines" || value.pattern === "none" || value.pattern === "dots"
      ? value.pattern
      : defaults.pattern;
    const storedBackground = normalizeColor(value.background, defaults.background);
    // Files written before the theme feature always carry the old soft-UI
    // default; treat any shipped default as "not customized" so those users
    // pick up the new default instead of being pinned to fog grey.
    const backgroundCustomized = typeof value.backgroundCustomized === "boolean"
      ? value.backgroundCustomized
      : !THEME_DEFAULT_BACKGROUNDS.has(storedBackground.toUpperCase());
    const storedInk = normalizeColor(value.patternColor, defaults.patternColor);
    const storedOpacity = normalizeOpacity(value.patternOpacity, defaults.patternOpacity);
    const inkCustomized = typeof value.inkCustomized === "boolean"
      ? value.inkCustomized
      : !(THEME_DEFAULT_INKS.has(storedInk.toUpperCase()) && THEME_DEFAULT_OPACITIES.includes(storedOpacity));
    return {
      pattern,
      background: backgroundCustomized ? storedBackground : defaults.background,
      patternColor: inkCustomized ? storedInk : defaults.patternColor,
      patternOpacity: inkCustomized ? storedOpacity : defaults.patternOpacity,
      backgroundCustomized,
      inkCustomized,
    };
  } catch {
    return { ...defaults };
  }
}

export function saveCanvasAppearance(storage: Storage, appearance: CanvasAppearance): void {
  try {
    storage.setItem(CANVAS_APPEARANCE_KEY, JSON.stringify(appearance));
  } catch {
    /* local preference storage is optional */
  }
}

/** `rgba()` for the pattern ink so the opacity slider stays cheap and exact. */
export function patternInk(appearance: CanvasAppearance): string {
  const hex = HEX_COLOR.test(appearance.patternColor) ? appearance.patternColor.slice(1) : "39434F";
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${normalizeOpacity(appearance.patternOpacity, 0.24)})`;
}
