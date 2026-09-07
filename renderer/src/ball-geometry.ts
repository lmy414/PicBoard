/*
 * Pure helpers for BloubBall's mouth/intake render and its clocked timeline.
 * Kept free of JSX so the geometry and choreography stay testable without a
 * DOM, mirroring the third-party engine's "sample is a pure function of time".
 *
 * "Mouth" = a real opening drawn in the lower body silhouette (an ellipse with
 * a darker cavity/tongue), sized in viewBox units so it is legible at the real
 * 68px ball: body diameter is 2*RAYON = 200 viewBox units, MOUTH_W 42 => a
 * ~13-14px wide mouth at display size; never the eyes, never a whole-ball CSS
 * scale.
 */

/**
 * Mouth width in viewBox units at full open (ball diameter is 200). At the
 * 68px ball this is ~12.9px wide, i.e. readable in the real 88px window.
 */
export const MOUTH_W = 60;
/** Mouth half-height at full open, as a fraction of MOUTH_W/2 (~9px tall). */
export const MOUTH_H_OPEN = 0.72;
/**
 * Symbolic image-card chip: half sizes in viewBox units. ~10.3 x 7.3px at the
 * 68px ball so the card sits visibly inside the open mouth (~13px wide).
 */
export const CHIP_HALF_W = 24;
export const CHIP_HALF_H = 17;

/** Mouth vertical center for the lower face of the main body shapes. */
export function mouthYForBody(shapeId: string | undefined, demo: boolean): number {
  if (demo) return 30;
  if (shapeId === "goutte") return 58;
  if (shapeId === "capsule") return 34;
  if (shapeId === "triangle") return 38;
  if (shapeId === "hexagone") return 44;
  if (shapeId === "squircle" || shapeId === "galet") return 50;
  return 46;
}

/** Chip center on screen y (mouth center x is always the body center). */
export function chipCenterY(shapeId: string | undefined, demo: boolean): number {
  return mouthYForBody(shapeId, demo);
}

export type IntakePhase = "idle" | "open" | "swallow" | "reject";

/** Deterministic target the frame clock feeds (per-phase segment schedule). */
export interface IntakeTarget {
  /** mouth opening 0..1 (1 = fully open) */
  mouth: number;
  /** chip presence 0..1 (1 = held in front of the mouth) */
  chip: number;
  /** swallow eat fraction 0..1 (1 = fully eaten) */
  eat: number;
  /** one-shot swallow pulse 0..1 envelope */
  pulse: number;
  /** 1 once the swallow has finished (stays 1 for the badge hold) */
  done: number;
}

export function neutralTarget(): IntakeTarget {
  return { mouth: 0, chip: 0, eat: 0, pulse: 0, done: 0 };
}

const easeIn = (t: number): number => t * t * t;
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

function seg(t: number, from: number, dur: number): number {
  return dur <= 0 ? 1 : Math.max(0, Math.min(1, (t - from) / dur));
}

/**
 * Phase target at time t (seconds since the phase anchor). Designed so the
 * consuming clock keeps continuity when a phase is held (open mouth during a
 * long import) or replayed (new intakeKey).
 */
export function targetAt(t: number, phase: IntakePhase, chipHeld: boolean): IntakeTarget {
  const out = neutralTarget();
  if (phase === "idle") return out;

  if (phase === "open") {
    // over = prepare to receive (mouth only); receiving = card held at mouth.
    out.mouth = easeOut(seg(t, 0, 0.18));
    if (chipHeld) out.chip = easeOut(seg(t, 0.1, 0.12));
    return out;
  }

  if (phase === "reject") {
    // error: card never swallowed, just fades as the mouth closes again.
    out.mouth = easeOut(seg(t, 0, 0.14)) * (1 - easeIn(seg(t, 0.24, 0.2)));
    out.chip = chipHeld ? 1 - easeIn(seg(t, 0.05, 0.14)) : 0;
    return out;
  }

  // swallow (one play-through per intakeKey; caller holds success until idle).
  out.mouth = easeOut(seg(t, 0, 0.08)) * (1 - easeIn(seg(t, 0.14, 0.2)));
  out.chip = easeOut(seg(t, 0.02, 0.1)) * (1 - easeIn(seg(t, 0.14, 0.2)));
  out.eat = seg(t, 0.16, 0.18);
  const p = seg(t, 0.34, 0.2);
  out.pulse = p < 1 ? Math.sin(Math.PI * p) * (1 - p * 0.35) : 0;
  out.done = seg(t, 0.56, 0.1);
  return out;
}

/** Phase for a BloubBall intake state (legacy props included by the caller). */
export function phaseFor(state: string | undefined, dragOpen: boolean, dropState: string | null | undefined): IntakePhase {
  if (state === "receiving") return "open";
  if (state === "over" || (dragOpen && !dropState)) return "open";
  if (state === "success" || dropState === "success") return "swallow";
  if (state === "error" || dropState === "error") return "reject";
  return "idle";
}

/** Legacy open used only when no intakeState is provided by the caller. */
export function legacyOpen(dragOpen: boolean): boolean {
  return dragOpen;
}

/**
 * Static targets for reduced-motion / motion=0: states are expressed with a
 * still open mouth, a held card, or the success badge — no fly-in, no bounce,
 * no swallow pulse. Functional information is preserved.
 */
export function staticTargetFor(phase: IntakePhase, chipHeld: boolean): IntakeTarget {
  const out = neutralTarget();
  if (phase === "open") {
    out.mouth = 1;
    out.chip = chipHeld ? 1 : 0;
  } else if (phase === "swallow") {
    // Success is conveyed by the fixed badge (done), not by a mouth replay.
    out.done = 1;
  }
  return out;
}
