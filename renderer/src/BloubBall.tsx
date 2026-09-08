import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BotEngine, type BotFrame } from "./third-party/bloub/engine";
import { NOTIF_BLUE, type DotRender } from "./third-party/bloub/decor";
import { COLOR_BY_ID, mixHex, SHAPE_BY_ID } from "./third-party/bloub/skins";
import type { StateId } from "./third-party/bloub/states";
import { DEMI_VIEWBOX, RAYON } from "./third-party/bloub/repere";
import { MAX_LOOK_PITCH, MAX_LOOK_YAW, pointerToLookTarget } from "../../shared/look-geometry";
import type { BallSettings } from "./ball-settings";
import "./ball-motion.css";
import { CHIP_HALF_H, CHIP_HALF_W, MOUTH_H_OPEN, MOUTH_W, chipCenterY, mouthYForBody, neutralTarget, phaseFor, staticTargetFor, targetAt, type IntakeTarget } from "./ball-geometry";

const REST_STATES: StateId[] = ["idle", "wink", "wide", "egg", "hexagon", "notify"];
const SPARK_STATES: StateId[] = ["idle", "thinking", "wink", "wide", "notify", "exclaim", "play", "burst", "comet"];

function statePool(animation: BallSettings["animation"]) {
  if (animation === "rest") return ["idle"] as StateId[];
  return animation === "spark" ? SPARK_STATES : REST_STATES;
}

function chooseNextState(pool: StateId[], current: StateId) {
  if (pool.length < 2) return pool[0] ?? "idle";
  const candidates = pool.filter((state) => state !== current);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? "idle";
}

function dotFill(dot: DotRender, body: string, paper: string) {
  if (dot.color) return dot.color;
  return dot.depth === undefined ? body : paper;
}

function luminance(hex: string) {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Mouth palette: readable on every body color (deep cavity + tongue/lip). */
function mouthPalette(bodyColor: string) {
  const light = luminance(bodyColor) > 0.42;
  return {
    cavity: light ? "#2a1412" : mixHex(bodyColor, "#000000", 0.35),
    tongue: light ? "#e8b7a2" : mixHex(bodyColor, "#ffffff", 0.3),
    rim: light ? mixHex(bodyColor, "#000000", 0.3) : mixHex(bodyColor, "#ffffff", 0.4),
  };
}

export type BallVariant = "ball" | "brand" | "preview";
export type BallIntakeState = "idle" | "over" | "receiving" | "success" | "error";

export interface BloubBallProps {
  settings: BallSettings;
  /** Legacy prop kept compatible (App feeds it during a file drag-over). */
  dragOpen?: boolean;
  /** Legacy prop kept compatible (App feeds it after a real import). */
  dropState?: "success" | "error" | null;
  /** Strict contract: intakeState/intakeKey/intakeCount maintained by caller. */
  intakeState?: BallIntakeState;
  /** Monotonic attempt id; bumping it replays the swallow for repeated success. */
  intakeKey?: number;
  /** Batch size the intake feedback represents (>=1). */
  intakeCount?: number;
  /** ball = full engine+intake, brand = static, preview = calm engine. */
  variant?: BallVariant;
}

/**
 * React client for bloub's measured, time-pure BotEngine plus the intake mouth
 * layer (plan 5.5).
 *
 * Clock: one monotonic per-instance clock in *engine seconds* (real time x
 * speed) that advances only while mounted + document-visible, never restarts on
 * speed/motion changes. Intake phase anchors are read from the same clock.
 *
 * Mouth semantics: a real dark mouth opens in the lower silhouette; the
 * symbolic chip is held in the opening while receiving, eaten (clipped) as the
 * mouth closes on success, and never eaten on error (reject). Success badge is
 * drawn in the fixed layout layer, centered on the body.
 */
export function BloubBall({
  settings,
  dragOpen = false,
  dropState = null,
  intakeState,
  intakeKey = 0,
  intakeCount = 1,
  variant = "ball",
}: BloubBallProps) {
  const uid = useId().replaceAll(":", "");
  const engineRef = useRef<BotEngine | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clockRef = useRef(0); // engine seconds (real x speed)
  const liveClockRef = useRef(0); // real seconds backing the engine clock
  const currentStateRef = useRef<StateId>("idle");
  const anchorRef = useRef<number | null>(null); // engine clock at phase start
  const phaseRef = useRef<ReturnType<typeof phaseFor>>("idle");
  const liveStateRef = useRef<string>("idle");
  const seenKeyRef = useRef(intakeKey);
  const targetRef = useRef<IntakeTarget>(neutralTarget());
  const [hovered, setHovered] = useState(false);
  const [frame, setFrame] = useState<BotFrame>(() => {
    const engine = new BotEngine(RAYON, "idle", SHAPE_BY_ID.get(settings.shapeId)?.radii ?? null);
    engineRef.current = engine;
    return engine.sample(0);
  });
  const [, setTick] = useState(0);

  const shape = SHAPE_BY_ID.get(settings.shapeId)?.radii ?? null;
  const bodyColor = COLOR_BY_ID.get(settings.colorId)?.hex ?? "#0a0a0c";
  const palette = useMemo(() => mouthPalette(bodyColor), [bodyColor]);
  const active = variant === "ball" || variant === "preview";

  // Single source of truth for what the ball is doing right now. The legacy
  // props keep working exactly as before when intakeState is not supplied.
  const state = intakeState ?? (dropState === "success" ? "success" : dropState === "error" ? "error" : dragOpen ? "over" : "idle");
  const phase = phaseFor(state, dragOpen, dropState);
  liveStateRef.current = state;

  const demo = variant === "preview";
  const geometry = useMemo(() => {
    const y = mouthYForBody(settings.shapeId, demo);
    return { mouthY: y, chipY: chipCenterY(settings.shapeId, demo) };
  }, [settings.shapeId, demo]);

  // One RAF loop owns the clock, the engine and the intake timeline.
  const reducedMotionRef = useRef(false);
  const motionRef = useRef(settings.motion);
  motionRef.current = settings.motion;
  useEffect(() => {
    if (variant !== "ball" && variant !== "preview") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = reducedMotion.matches;
    const onChange = (event: MediaQueryListEvent) => { reducedMotionRef.current = event.matches; };
    reducedMotion.addEventListener?.("change", onChange);
    return () => reducedMotion.removeEventListener?.("change", onChange);
  }, [variant]);

  useEffect(() => {
    if (variant !== "ball" && variant !== "preview") return;
    const engine = engineRef.current;
    if (!engine) return;
    const pool = statePool(settings.animation);
    let raf = 0;
    let last = performance.now();
    let nextStateAt = settings.animation === "rest" ? Number.POSITIVE_INFINITY : 1.25;

    const step = (now: number) => {
      if (document.visibilityState === "hidden") {
        // Keep the clock from advancing while the tab/window is hidden, and
        // avoid catching up when it becomes visible again.
        last = now;
        raf = requestAnimationFrame(step);
        return;
      }
      const realDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      liveClockRef.current += realDt;
      clockRef.current += realDt * settings.speed;
      const clock = clockRef.current;

      const inPhase = phaseRef.current;
      // prefers-reduced-motion / motion=0 switch the JS engine to static
      // functional targets (no idle morph pool, no swallow bounce).
      const reduced = reducedMotionRef.current || motionRef.current <= 0.001;
      if (inPhase === "idle") {
        // Quiet rest only outside intake feedback (plan 4.3: restrained idle).
        if (!reduced && pool.length > 1 && clock >= nextStateAt) {
          const next = chooseNextState(pool, currentStateRef.current);
          currentStateRef.current = next;
          engine.setState(next, clock);
          nextStateAt = clock + (1.2 + Math.random() * 2.2);
        } else if (currentStateRef.current !== "idle") {
          currentStateRef.current = "idle";
          engine.setState("idle", clock);
        }
        targetRef.current = neutralTarget();
      } else {
        const since = anchorRef.current === null ? 0 : Math.max(0, clock - anchorRef.current);
        targetRef.current = reduced ? staticTargetFor(inPhase, liveStateRef.current === "receiving" || liveStateRef.current === "success") : targetAt(since, inPhase, liveStateRef.current === "receiving" || liveStateRef.current === "success");
      }

      setFrame(engine.sample(clock));
      setTick((t) => t + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Restarts only on structural inputs; intake prop changes are handled by
    // the anchor effect so the clock itself stays continuous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, settings.animation, settings.speed, settings.shapeId]);

  // React to intake phase changes without restarting the clock: anchor the
  // timeline at the current engine time, replay swallows only on a new key.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const nextPhase = phaseFor(state, dragOpen, dropState);
    engine.setShape(shape, clockRef.current);
    engine.setLook(settings.followGaze ? nextPhase === "idle" ? { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 } : { yaw: 0, pitch: 9, mix: 0.6, spin: 0, wander: 0 } : null, clockRef.current);
    if (phaseRef.current === nextPhase) {
      if (nextPhase === "swallow" && seenKeyRef.current !== intakeKey) {
        seenKeyRef.current = intakeKey;
        anchorRef.current = clockRef.current;
      }
      return;
    }
    phaseRef.current = nextPhase;
    seenKeyRef.current = intakeKey;
    if (nextPhase === "idle") {
      anchorRef.current = null;
      targetRef.current = neutralTarget();
      engine.setState("idle", clockRef.current);
    } else {
      anchorRef.current = clockRef.current;
    }
  }, [state, intakeKey, dragOpen, dropState, settings.followGaze, settings.shapeId, shape]);

  // Pointer gaze following (window cursor publisher + local pointermove).
  const updateLookAt = (clientX: number, clientY: number) => {
    const engine = engineRef.current;
    if (!engine || !settings.followGaze || !active) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((clientY - rect.top) / rect.height - 0.5) * 2;
    const target = pointerToLookTarget(x, y, MAX_LOOK_YAW, MAX_LOOK_PITCH);
    engine.setLook({ ...target, mix: 0.88, spin: 0, wander: 0 }, clockRef.current);
  };

  useEffect(() => {
    if (!settings.followGaze || !active) return;
    const handlePointerMove = (event: PointerEvent) => updateLookAt(event.clientX, event.clientY);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    const unsubscribe = window.imageBoard.onCursorPosition((position) => updateLookAt(position.x - position.windowX, position.y - position.windowY));
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.followGaze, active]);

  const target = targetRef.current;
  const reducedMotion = reducedMotionRef.current || settings.motion <= 0.001;
  const maskId = `bloub-mask-${uid}`;
  const chipClipId = `qib-mouth-clip-${uid}`;

  const phaseClass =
    phase === "swallow" ? "qib-intake-swallow"
      : phase === "reject" ? "qib-intake-reject"
        : phase === "open" && state === "receiving" ? "qib-intake-receiving"
          : phase === "open" ? "qib-intake-open"
            : "qib-intake-idle";

  const mouthRx = (MOUTH_W / 2) * target.mouth;
  const mouthRy = (MOUTH_W / 2) * MOUTH_H_OPEN * target.mouth;
  const mouthOpen = mouthRy > 1;
  // The chip exists while receiving, while the swallow is eating it, and
  // briefly during reject (then it fades without being swallowed).
  const chipShown = state === "receiving" || phase === "swallow" || phase === "reject";
  // As the mouth closes the chip is clipped and scales down into the hole.
  const chipScale = chipShown ? Math.max(0.001, target.chip * (1 - target.eat * 0.9)) : 0.001;
  const chipVisible = chipShown && mouthOpen && chipScale > 0.02;
  const swallowT = target.pulse * Math.max(0, Math.min(1, settings.motion));
  // Badge appears just after the swallow pulse and holds while the caller
  // keeps success active (typically until App resets to idle). Drawn in the
  // fixed layout layer at a scale matched to the 68px ball (r15 => ~6.5px).
  const badgeShow = false; // The stable outer CollapsedBall layer owns the sole result badge.

  const chipOpacity = swallowT > 0 ? 1 - swallowT * 0.6 : target.chip < 1 ? target.chip : 1;

  const svgClass = [
    "bloub-svg",
    "qib-bloub",
    hovered && active ? "bloub-hovered" : "",
    dragOpen ? "bloub-drag-open" : "",
    dropState === "success" ? "bloub-drop-success" : dropState === "error" ? "bloub-drop-error" : "",
    phaseClass,
  ].filter(Boolean).join(" ");

  const style = {
    "--bloub-morph-duration": "0s",
    "--qib-chip-x": "0px",
    "--qib-chip-y": `${geometry.chipY}px`,
  } as CSSProperties;

  const ariaLabel =
    state === "receiving" ? `正在接收 ${intakeCount} 张图片`
      : state === "over" ? "把图片放到嘴边"
        : state === "success" ? `已接收 ${intakeCount} 张图片`
          : state === "error" ? "图片接收失败"
            : "PicBoard 悬浮图片画板";

  return (
    <svg
      ref={svgRef}
      className={svgClass}
      style={style}
      viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`}
      role="img"
      aria-label={ariaLabel}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerMove={(event) => updateLookAt(event.clientX, event.clientY)}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, index) => <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />)}
          {frame.notch && <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />}
        </mask>
        {frame.arcs.map((arc) => <linearGradient key={arc.id} id={`${uid}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>{arc.grad.stops.map((stop, index) => <stop key={index} offset={index / Math.max(1, arc.grad.stops.length - 1)} stopColor={stop} />)}</linearGradient>)}
        {chipVisible && (
          <clipPath id={chipClipId}>
            <ellipse cx="0" cy={geometry.chipY} rx={Math.max(0.5, mouthRx * 0.92)} ry={Math.max(0.5, mouthRy * 0.92)} />
          </clipPath>
        )}
      </defs>

      <g className="bloub-arcs" fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={`back-${arc.id}`} d={arc.back} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>
      {frame.dotsBehind && <g>{frame.dots.map((dot, index) => <Dot key={`behind-${index}`} dot={dot} bodyColor={bodyColor} paper={settings.eyeColor} />)}</g>}

      <g className="bloub-core" opacity={frame.bodyAlpha} transform={swallowT > 0 ? `scale(${1 - swallowT * 0.06}) translate(0 ${swallowT * 2})` : undefined}>
        <path d={frame.bodyPath} fill={settings.eyeColor} />
        <g mask={`url(#${maskId})`}><rect x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2} fill={bodyColor} /></g>

        {/* Mouth interior: cavity + tongue/lip over the masked hole. */}
        {mouthOpen && (
          <g className="qib-mouth">
            <ellipse cx="0" cy={geometry.mouthY} rx={mouthRx} ry={mouthRy} fill={palette.cavity} />
            {luminance(bodyColor) <= 0.42 && <ellipse cx="0" cy={geometry.mouthY - mouthRy * 0.15} rx={mouthRx * 0.9} ry={mouthRy * 0.22} fill={palette.rim} opacity={0.55} />}
            <ellipse cx="0" cy={geometry.mouthY + mouthRy * 0.3} rx={mouthRx * 0.55} ry={mouthRy * 0.42} fill={palette.tongue} opacity={0.9} />
          </g>
        )}

        {/* Intake chip clipped inside the mouth opening; swallowed as the
            mouth closes (success) or faded back out (reject). */}
        {chipVisible && (
          <g clipPath={`url(#${chipClipId})`} className="qib-intake-layer">
            <g className="qib-intake-chip" opacity={chipOpacity} transform={`translate(0 ${geometry.chipY}) scale(${chipScale}) translate(0 ${-geometry.chipY})`}>
              {intakeCount > 1 && <Chip offset={{ x: -10, y: 5 }} dim />}
              <Chip offset={{ x: 0, y: 0 }} />
            </g>
          </g>
        )}
      </g>

      {!frame.dotsBehind && <g>{frame.dots.map((dot, index) => <Dot key={`front-${index}`} dot={dot} bodyColor={bodyColor} paper={settings.eyeColor} />)}</g>}
      {frame.notif && <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />}
      <g className="bloub-arcs" fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={`front-${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>

      {/* Success badge: fixed centered circle+check, ~15px diameter at the
          68px ball; on the fixed layout layer so the swallow scale never
          shifts its center. */}
      {badgeShow && (
        <g className="qib-intake-badge">
          <circle cx="0" cy="0" r="17" fill="#10a37f" />
          <path d="M-6.2 0.6 L-2 4.8 L6.6 -4.2" fill="none" stroke="#ffffff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}

function Chip({ offset, dim }: { offset: { x: number; y: number }; dim?: boolean }) {
  const w = CHIP_HALF_W * 2;
  const h = CHIP_HALF_H * 2;
  const opacity = dim ? 0.55 : 1;
  return (
    <g transform={`translate(${offset.x} ${offset.y})`} opacity={opacity}>
      <rect x={-CHIP_HALF_W} y={-CHIP_HALF_H} width={w} height={h} rx="4" fill={dim ? "#cfd4d0" : "#ffffff"} stroke={dim ? "#9aa29c" : "#c9d1cb"} strokeWidth="2" />
      <rect x={-CHIP_HALF_W + 5} y={-CHIP_HALF_H + 5} width={w - 10} height={h - 10} rx="2" fill="#e6efe9" />
      <path d={`M${-CHIP_HALF_W + 6} ${CHIP_HALF_H - 6} L${-3} ${-2} L${3} 4 L${7} 0 L${CHIP_HALF_W - 6} ${CHIP_HALF_H - 6} Z`} fill="#4dab8a" />
    </g>
  );
}

function Dot({ dot, bodyColor, paper }: { dot: DotRender; bodyColor: string; paper: string }) {
  const fill = dotFill(dot, bodyColor, paper);
  if (dot.d) return <path d={dot.d} fill={fill} opacity={dot.opacity} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`} />;
  return <circle cx={dot.x} cy={dot.y} r={dot.r} fill={fill} opacity={dot.opacity} />;
}
