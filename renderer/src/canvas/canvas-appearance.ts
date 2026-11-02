/** Canvas surface look: pattern, background and pattern ink. Local renderer preference. */

export type CanvasPattern = "dots" | "lines" | "none";

export interface CanvasAppearance {
  pattern: CanvasPattern;
  /** Six-digit hex background. */
  background: string;
  /** Six-digit hex pattern ink. */
  patternColor: string;
  /** 0..1 ink alpha. */
  patternOpacity: number;
  /** True once the user picked a background. */
  backgroundCustomized: boolean;
  /** True once the user picked an ink color/opacity. */
  inkCustomized: boolean;
}

export const CANVAS_APPEARANCE_KEY = "quick-image-board.canvas-appearance";

type CanvasDefaults = Pick<CanvasAppearance, "background" | "patternColor" | "patternOpacity">;

/** The single canvas look: a white board with a faint dot grid. */
const CANVAS_DEFAULTS: CanvasDefaults = {
  background: "#FFFFFF",
  patternColor: "#202421",
  patternOpacity: 0.1,
};

export const DEFAULT_CANVAS_APPEARANCE: CanvasAppearance = {
  pattern: "dots",
  ...CANVAS_DEFAULTS,
  backgroundCustomized: false,
  inkCustomized: false,
};

/**
 * Factory looks from earlier builds. Records without customization flags that
 * still carry one of these were never touched by the user, so they migrate to
 * `CANVAS_DEFAULTS` instead of pinning a retired look.
 */
const LEGACY_CANVAS_DEFAULTS: readonly CanvasDefaults[] = [
  { background: "#E8ECF1", patternColor: "#39434F", patternOpacity: 0.24 },
  { background: "#FBFBFA", patternColor: "#37352F", patternOpacity: 0.22 },
];

const LEGACY_BACKGROUNDS = new Set(LEGACY_CANVAS_DEFAULTS.map((defaults) => defaults.background));

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toUpperCase() : null;
}

function normalizeOpacity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export function readCanvasAppearance(storage: Storage): CanvasAppearance {
  try {
    const raw = storage.getItem(CANVAS_APPEARANCE_KEY);
    const value = raw ? JSON.parse(raw) as Partial<CanvasAppearance> : {};
    const pattern = value.pattern === "lines" || value.pattern === "none" || value.pattern === "dots"
      ? value.pattern
      : DEFAULT_CANVAS_APPEARANCE.pattern;
    const storedBackground = normalizeColor(value.background);
    // A legacy record has no flags: a factory colour means untouched, anything
    // else was chosen by the user and must survive the migration.
    const backgroundCustomized = typeof value.backgroundCustomized === "boolean"
      ? value.backgroundCustomized
      : storedBackground !== null && !LEGACY_BACKGROUNDS.has(storedBackground);
    const storedInk = normalizeColor(value.patternColor);
    const storedOpacity = normalizeOpacity(value.patternOpacity);
    const completeLegacyInk = storedInk !== null
      && storedOpacity !== null
      && LEGACY_CANVAS_DEFAULTS.some((defaults) => defaults.patternColor === storedInk && defaults.patternOpacity === storedOpacity);
    // Only a complete retired ink pair means untouched. Otherwise each valid
    // field is kept, even when its sibling is missing or invalid.
    const inkCustomized = typeof value.inkCustomized === "boolean"
      ? value.inkCustomized
      : !completeLegacyInk && (storedInk !== null || storedOpacity !== null);
    return {
      pattern,
      background: backgroundCustomized && storedBackground !== null ? storedBackground : CANVAS_DEFAULTS.background,
      patternColor: inkCustomized && storedInk !== null ? storedInk : CANVAS_DEFAULTS.patternColor,
      patternOpacity: inkCustomized && storedOpacity !== null ? storedOpacity : CANVAS_DEFAULTS.patternOpacity,
      backgroundCustomized,
      inkCustomized,
    };
  } catch {
    return { ...DEFAULT_CANVAS_APPEARANCE };
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
  const hex = (normalizeColor(appearance.patternColor) ?? CANVAS_DEFAULTS.patternColor).slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${normalizeOpacity(appearance.patternOpacity) ?? CANVAS_DEFAULTS.patternOpacity})`;
}
