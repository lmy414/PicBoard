import { useEffect, useRef, useState } from "react";

/**
 * Small single-purpose animation helper for the UI lane (contract:
 * `ui/motion.ts`). Time-based, RAF-driven, springs with exactly one visible
 * overshoot and hooks for completion/cleanup.
 */

export interface SpringOptions {
  /** Visual stiffness (higher = snappier). */
  stiffness?: number;
  /** Damping ratio against critical damping (>=1: no oscillation). */
  damping?: number;
  /** Initial velocity in output units per second. */
  initialVelocity?: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
  initialVelocity: number;
}

export function normalizeSpring(options?: SpringOptions): SpringConfig {
  return {
    stiffness: options?.stiffness ?? 300,
    damping: options?.damping ?? 26,
    initialVelocity: options?.initialVelocity ?? 0,
  };
}

/**
 * Resolve a 1D damped spring to `1` from `0`. `now` is absolute time (ms);
 * `startedAt` marks the start. Returns the eased progress in [0,1] and a
 * boolean that is true once the spring has visually settled.
 */
export function springProgress(now: number, startedAt: number, options?: SpringOptions): [number, boolean] {
  const { stiffness, damping, initialVelocity } = normalizeSpring(options);
  const t = Math.max(0, (now - startedAt) / 1000);
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  let value: number;
  let velocity: number;
  let settled: boolean;
  if (zeta >= 1) {
    const c1 = 1;
    const c2 = (initialVelocity + omega * 1) / omega;
    value = 1 - (c1 + c2 * t) * Math.exp(-omega * t);
    velocity = (c2 - omega * (c1 + c2 * t)) * Math.exp(-omega * t);
    settled = Math.abs(1 - value) < 0.001 && Math.abs(velocity) < 0.001;
  } else {
    const damped = omega * Math.sqrt(1 - zeta * zeta);
    const amplitude = 1;
    const c2 = (initialVelocity + zeta * omega * amplitude) / damped;
    value = 1 - amplitude * Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + (c2 / amplitude) * Math.sin(damped * t));
    velocity = amplitude * Math.exp(-zeta * omega * t) * ((zeta * omega * (Math.cos(damped * t) + (c2 / amplitude) * Math.sin(damped * t))) - (-damped * Math.sin(damped * t) + c2 * Math.cos(damped * t)));
    settled = Math.abs(1 - value) < 0.001 && Math.abs(velocity) < 0.004;
  }
  return [Math.min(1, Math.max(0, value)), settled];
}

/** Eased `value`, driven by `t` in [0,1]. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

/**
 * Evaluate a CSS cubic-bezier(x1, y1, x2, y2) timing function at `t`, so JS
 * motion (FLIP, edge following) matches the CSS motion tokens exactly.
 * Solves x(s) = t by bisection, then returns y(s).
 */
export function cubicBezierProgress(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const progress = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const curve = (a1: number, a2: number, s: number): number =>
    3 * (1 - s) * (1 - s) * s * a1 + 3 * (1 - s) * s * s * a2 + s * s * s;
  let low = 0;
  let high = 1;
  let s = progress;
  for (let i = 0; i < 24; i += 1) {
    const current = curve(x1, x2, s);
    if (Math.abs(current - progress) < 1e-5) break;
    if (current < progress) low = s;
    else high = s;
    s = (low + high) / 2;
  }
  return curve(y1, y2, s);
}

/** Eased `value`, with a single visible overshoot near the end. */
export function easeOutBack(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  const c1 = 1.32;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/**
 * Hover a `dismissed` flag after `delayMs` (e.g. to delay showing the busy
 * indicator until processing has taken ~200ms). Resets whenever the deps
 * change. Returns whether the delay window has elapsed.
 */
export function useDelayedFlag(delayMs: number, active: boolean): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const id = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs, active]);
  return active && elapsed;
}

export interface PresenceState {
  /** Render the element while true (including the exit window). */
  mounted: boolean;
  /** Feed to `data-motion`; CSS presets key on enter/exit. */
  phase: "enter" | "idle" | "exit";
}

/** Enter preset duration; must stay in sync with --motion-base. */
const PRESENCE_ENTER_MS = 200;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep a popup/row mounted through its exit animation and expose the phase for
 * the CSS presets. Usage:
 *
 *   const presence = usePresence(open, 140);
 *   if (!presence.mounted) return null;
 *   return <div className="motion-pop" data-motion={presence.phase}>…</div>;
 *
 * Enter plays for 200 ms and then settles to "idle"; exit keeps `mounted` true
 * for `exitMs` so the shorter ease-in exit can finish. Reduced motion unmounts
 * (and settles) immediately.
 */
export function usePresence(open: boolean, exitMs = 160): PresenceState {
  const [state, setState] = useState<PresenceState>(() => ({ mounted: open, phase: open ? "enter" : "idle" }));
  const mountedRef = useRef(state.mounted);
  mountedRef.current = state.mounted;

  useEffect(() => {
    if (open) {
      const reduced = prefersReducedMotion();
      setState({ mounted: true, phase: reduced ? "idle" : "enter" });
      if (reduced) return;
      const timer = window.setTimeout(() => {
        setState((current) => (current.mounted ? { mounted: true, phase: "idle" } : current));
      }, PRESENCE_ENTER_MS);
      return () => window.clearTimeout(timer);
    }
    if (!mountedRef.current) return;
    if (prefersReducedMotion()) {
      setState({ mounted: false, phase: "idle" });
      return;
    }
    setState({ mounted: true, phase: "exit" });
    const timer = window.setTimeout(() => setState({ mounted: false, phase: "idle" }), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);

  return state;
}
