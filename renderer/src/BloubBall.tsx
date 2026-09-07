import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BotEngine, type BotFrame } from "./third-party/bloub/engine";
import { NOTIF_BLUE, type DotRender } from "./third-party/bloub/decor";
import { COLOR_BY_ID, SHAPE_BY_ID } from "./third-party/bloub/skins";
import type { StateId } from "./third-party/bloub/states";
import { DEMI_VIEWBOX, RAYON } from "./third-party/bloub/repere";
import { MAX_LOOK_PITCH, MAX_LOOK_YAW, pointerToLookTarget } from "../../shared/look-geometry";
import type { BallSettings } from "./ball-settings";

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

/**
 * React client for bloub's measured, time-pure BotEngine.
 * Source adapted from jeremy-prt/bloub under MIT; see third-party/bloub/LICENSE.
 */
type BallDropState = "success" | "error" | null;

export function BloubBall({ settings, dragOpen = false, dropState = null }: { settings: BallSettings; dragOpen?: boolean; dropState?: BallDropState }) {
  const uid = useId().replaceAll(":", "");
  const engineRef = useRef<BotEngine | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clockRef = useRef(0);
  const currentStateRef = useRef<StateId>("idle");
  const [hovered, setHovered] = useState(false);
  const shape = SHAPE_BY_ID.get(settings.shapeId)?.radii ?? null;
  const bodyColor = COLOR_BY_ID.get(settings.colorId)?.hex ?? "#0a0a0c";
  const animationDuration = `${Math.max(1.5, 5 - settings.motion * 2.5)}s`;
  const [frame, setFrame] = useState<BotFrame>(() => {
    const engine = new BotEngine(RAYON, "idle", shape);
    engineRef.current = engine;
    return engine.sample(0);
  });

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setShape(shape, clockRef.current);
    engine.setLook(settings.followGaze ? { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 } : null, clockRef.current);
  }, [settings.followGaze, settings.shapeId]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const pool = statePool(settings.animation);
    const startedAt = performance.now();
    let nextStateAt = settings.animation === "rest" ? Number.POSITIVE_INFINITY : 1.25;
    let raf = 0;

    const tick = (now: number) => {
      const clock = ((now - startedAt) / 1000) * settings.speed;
      clockRef.current = clock;
      if (clock >= nextStateAt) {
        const next = chooseNextState(pool, currentStateRef.current);
        currentStateRef.current = next;
        engine.setState(next, clock);
        nextStateAt = clock + (1.2 + Math.random() * 2.2);
      } else if (settings.animation === "rest" && currentStateRef.current !== "idle") {
        currentStateRef.current = "idle";
        engine.setState("idle", clock);
      }
      setFrame(engine.sample(clock));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settings.animation, settings.speed]);

  const updateLookAt = (clientX: number, clientY: number) => {
    const engine = engineRef.current;
    if (!engine || !settings.followGaze) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = ((clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((clientY - rect.top) / rect.height - 0.5) * 2;
    const target = pointerToLookTarget(x, y, MAX_LOOK_YAW, MAX_LOOK_PITCH);
    engine.setLook({ ...target, mix: 0.88, spin: 0, wander: 0 }, clockRef.current);
  };

  useEffect(() => {
    if (!settings.followGaze) return;
    const handlePointerMove = (event: PointerEvent) => updateLookAt(event.clientX, event.clientY);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    const unsubscribe = window.imageBoard.onCursorPosition((position) => updateLookAt(position.x - position.windowX, position.y - position.windowY));
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      unsubscribe();
    };
  }, [settings.followGaze]);

  const maskId = `bloub-mask-${uid}`;
  const style = { "--bloub-morph-duration": animationDuration } as CSSProperties;

  return <svg ref={svgRef} className={`bloub-svg ${hovered ? "bloub-hovered" : ""} ${dragOpen ? "bloub-drag-open" : ""} ${dropState === "success" ? "bloub-drop-success" : dropState === "error" ? "bloub-drop-error" : ""}`} style={style} viewBox={`${-DEMI_VIEWBOX} ${-DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`} role="img" aria-label="快捷图片画布" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onPointerMove={(event) => updateLookAt(event.clientX, event.clientY)}>
    <defs>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2}>
        <path d={frame.bodyPath} fill="#fff" />
        {frame.eyes.map((eye, index) => <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />)}
        {frame.notch && <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />}
      </mask>
      {frame.arcs.map((arc) => <linearGradient key={arc.id} id={`${uid}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>{arc.grad.stops.map((stop, index) => <stop key={index} offset={index / Math.max(1, arc.grad.stops.length - 1)} stopColor={stop} />)}</linearGradient>)}
    </defs>
    {hovered && <g className="bloub-hover-sparks" aria-hidden="true"><circle className="bloub-hover-ring" cx="0" cy="0" r="111" /><circle className="bloub-hover-dot bloub-hover-dot-a" cx="-106" cy="-20" r="3" /><circle className="bloub-hover-dot bloub-hover-dot-b" cx="101" cy="-34" r="2.5" /><circle className="bloub-hover-dot bloub-hover-dot-c" cx="86" cy="71" r="2" /></g>}
    <g className="bloub-arcs" fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={`back-${arc.id}`} d={arc.back} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>
    {frame.dotsBehind && <g>{frame.dots.map((dot, index) => <Dot key={`behind-${index}`} dot={dot} bodyColor={bodyColor} paper={settings.eyeColor} />)}</g>}
    <g className="bloub-core" opacity={frame.bodyAlpha}>
      <path d={frame.bodyPath} fill={settings.eyeColor} />
      <g mask={`url(#${maskId})`}><rect x={-DEMI_VIEWBOX} y={-DEMI_VIEWBOX} width={DEMI_VIEWBOX * 2} height={DEMI_VIEWBOX * 2} fill={bodyColor} /></g>
    </g>
    {!frame.dotsBehind && <g>{frame.dots.map((dot, index) => <Dot key={`front-${index}`} dot={dot} bodyColor={bodyColor} paper={settings.eyeColor} />)}</g>}
    {frame.notif && <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />}
    <g className="bloub-arcs" fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={`front-${arc.id}`} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>
  </svg>;
}

function Dot({ dot, bodyColor, paper }: { dot: DotRender; bodyColor: string; paper: string }) {
  const fill = dotFill(dot, bodyColor, paper);
  if (dot.d) return <path d={dot.d} fill={fill} opacity={dot.opacity} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`} />;
  return <circle cx={dot.x} cy={dot.y} r={dot.r} fill={fill} opacity={dot.opacity} />;
}
