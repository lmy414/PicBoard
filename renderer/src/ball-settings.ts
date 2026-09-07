import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID } from "./third-party/bloub/skins";

export type BallAnimationMode = "random" | "rest" | "spark";

export interface BallSettings {
  colorId: string;
  eyeColor: string;
  shapeId: string;
  animation: BallAnimationMode;
  /** 0.5x..2x: time scaling of the animation clock (fast = lively, 1 = real-time). */
  speed: number;
  /** 0..1: amplitude scaling. 0 = no idle morph / no swallow bounce (plan 5.2). */
  motion: number;
  followGaze: boolean;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BALL_SETTINGS_KEY = "quick-image-board.ball-settings";

/**
 * Speed/motion semantics (plan 5.2): motion controls amplitude, speed controls
 * time. motion=0 removes the idle morph, hover sparkles and swallow bounce
 * while leaving functional state feedback visible (static mouth/chip/badge).
 * Old stored settings keep their schema and ranges; only the absence of any
 * stored value yields the calmer default below (plan 4.3 "quiet idle").
 */
export const DEFAULT_BALL_SETTINGS: BallSettings = {
  colorId: DEFAULT_COLOR,
  eyeColor: "#ffffff",
  shapeId: DEFAULT_SHAPE,
  animation: "rest",
  speed: 1,
  motion: 0.4,
  followGaze: true,
};

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function normalizeBallSettings(value: unknown): BallSettings {
  const candidate = value && typeof value === "object" ? value as Partial<BallSettings> : {};
  const colorId = typeof candidate.colorId === "string" && COLOR_BY_ID.has(candidate.colorId) ? candidate.colorId : DEFAULT_BALL_SETTINGS.colorId;
  const shapeId = typeof candidate.shapeId === "string" && SHAPE_BY_ID.has(candidate.shapeId) ? candidate.shapeId : DEFAULT_BALL_SETTINGS.shapeId;
  const eyeColor = typeof candidate.eyeColor === "string" && /^#[0-9a-f]{6}$/i.test(candidate.eyeColor) ? candidate.eyeColor : DEFAULT_BALL_SETTINGS.eyeColor;
  const animation = candidate.animation === "rest" || candidate.animation === "spark" || candidate.animation === "random" ? candidate.animation : DEFAULT_BALL_SETTINGS.animation;
  return {
    colorId,
    eyeColor,
    shapeId,
    animation,
    speed: numberInRange(candidate.speed, DEFAULT_BALL_SETTINGS.speed, 0.5, 2),
    motion: numberInRange(candidate.motion, DEFAULT_BALL_SETTINGS.motion, 0, 1),
    followGaze: typeof candidate.followGaze === "boolean" ? candidate.followGaze : DEFAULT_BALL_SETTINGS.followGaze,
  };
}

export function readBallSettings(storage?: StorageLike): BallSettings {
  if (!storage) return { ...DEFAULT_BALL_SETTINGS };
  try {
    const raw = storage.getItem(BALL_SETTINGS_KEY);
    return raw ? normalizeBallSettings(JSON.parse(raw)) : { ...DEFAULT_BALL_SETTINGS };
  } catch {
    return { ...DEFAULT_BALL_SETTINGS };
  }
}

export function saveBallSettings(storage: StorageLike | undefined, settings: BallSettings) {
  if (!storage) return;
  try { storage.setItem(BALL_SETTINGS_KEY, JSON.stringify(normalizeBallSettings(settings))); } catch { /* storage can be unavailable in private contexts */ }
}
