import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { DEFAULT_BALL_SETTINGS, type BallSettings, type BallAnimationMode } from "./ball-settings";
import "./orb-demo.css";

type Pose = { x: number; y: number; angle: number; vx: number; vy: number; angularV: number };
type Mood = "idle" | "attention" | "receiving" | "success" | "error" | "impact";

const REST: Pose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angularV: 0 };
const SOURCE_PARTS = {
  support: new URL("../../character-assets/blue-haired-head/source-layers/source-support.png", import.meta.url).href,
  face: new URL("../../character-assets/blue-haired-head/source-layers/face.png", import.meta.url).href,
  leftEye: new URL("../../character-assets/blue-haired-head/source-layers/eye-left.png", import.meta.url).href,
  rightEye: new URL("../../character-assets/blue-haired-head/source-layers/eye-right.png", import.meta.url).href,
  hairCrown: new URL("../../character-assets/blue-haired-head/source-layers/hair-crown.png", import.meta.url).href,
  hairFringeLeft: new URL("../../character-assets/blue-haired-head/source-layers/hair-fringe-left.png", import.meta.url).href,
  hairFringeRight: new URL("../../character-assets/blue-haired-head/source-layers/hair-fringe-right.png", import.meta.url).href,
  hairSideRight: new URL("../../character-assets/blue-haired-head/source-layers/hair-side-right.png", import.meta.url).href,
  hairTips: new URL("../../character-assets/blue-haired-head/source-layers/hair-tips-lower.png", import.meta.url).href,
  hairSideLeft: new URL("../../character-assets/blue-haired-head/source-layers/hair-side-left.png", import.meta.url).href,
} as const;
type VisibleParts = { face: boolean; leftEye: boolean; rightEye: boolean; hair: boolean };

const STATUS: Record<Mood, string> = {
  idle: "待机 · 呼吸、眨眼与轻微游移",
  attention: "注意到你 · 小脑袋进入关注姿态",
  receiving: "正在收图 · 前倾迎接",
  success: "收图成功 · 弹跳庆祝",
  error: "收图失败 · 轻轻摇头",
  impact: "碰撞 · 软弹回馈",
};

function AnimeOrb({ mood, motion, speed, squash, stretch, impact, pose, visibleParts }: {
  mood: Mood;
  motion: number;
  speed: number;
  squash: number;
  stretch: number;
  impact: boolean;
  pose: Pose;
  visibleParts: VisibleParts;
}) {
  const idleDuration = 3.2 / Math.max(0.5, Math.min(2, speed));
  const style = useMemo(() => ({
    "--idle-duration": `${idleDuration}s`,
    "--motion-scale": `${motion}`,
    "--squash-x": `${1 + squash}`,
    "--squash-y": `${1 - stretch}`,
  }) as CSSProperties, [idleDuration, motion, squash, stretch]);

  const clamped = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  const lagX = clamped(-pose.vx * 0.0012, 2.5);
  const lagY = clamped(-pose.vy * 0.001, 2.5);
  const hairLag = (x: number, y: number, angle: number) => ({
    transform: `translate3d(${lagX * x}px, ${lagY * y}px, 0) rotate(${clamped(-pose.angle * angle, 0.8)}deg)`,
  });

  return (
    <div className={`anime-orb mood-${mood} ${impact ? "is-impact" : ""}`} style={style}>
      <div className="character-bob" role="img" aria-label="蓝发二次元小球">
        <img className="character-part source-support" src={SOURCE_PARTS.support} draggable={false} alt="" />
        {visibleParts.face && <img className="character-part face-part" src={SOURCE_PARTS.face} draggable={false} alt="" />}
        {visibleParts.leftEye && <img className="character-part eye-part" src={SOURCE_PARTS.leftEye} draggable={false} alt="" />}
        {visibleParts.rightEye && <img className="character-part eye-part" src={SOURCE_PARTS.rightEye} draggable={false} alt="" />}
        {visibleParts.hair && <>
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairCrown} style={hairLag(0.5, 0.35, 0.2)} draggable={false} alt="" />
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairFringeLeft} style={hairLag(0.35, 0.4, 0.12)} draggable={false} alt="" />
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairFringeRight} style={hairLag(0.65, 0.4, 0.14)} draggable={false} alt="" />
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairSideRight} style={hairLag(1, 0.65, 0.24)} draggable={false} alt="" />
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairTips} style={hairLag(0.45, 1, 0.2)} draggable={false} alt="" />
          <img className="character-part source-motion-slice" src={SOURCE_PARTS.hairSideLeft} style={hairLag(0.2, 0.7, 0.16)} draggable={false} alt="" />
        </>}
      </div>
    </div>
  );
}

export default function OrbDemo() {
  const [settings, setSettings] = useState<BallSettings>({
    ...DEFAULT_BALL_SETTINGS,
    colorId: "bleu",
    animation: "spark",
    speed: 1.05,
    motion: 0.62,
    followGaze: true,
  });
  const [mood, setMood] = useState<Mood>("idle");
  const [dragging, setDragging] = useState(false);
  const [pose, setPose] = useState<Pose>(REST);
  const [impact, setImpact] = useState(false);
  const [visibleParts, setVisibleParts] = useState<VisibleParts>({ face: true, leftEye: true, rightEye: true, hair: true });
  const poseRef = useRef<Pose>({ ...REST });
  const pointerRef = useRef({ id: -1, x: 0, y: 0, at: 0, grabX: 0, grabY: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const statusTimer = useRef<number | undefined>(undefined);
  const impactTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let raf = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - previous) / 1000);
      previous = now;
      const p = poseRef.current;
      if (!dragging) {
        // A damped spring hangs the character near center; gravity adds a tiny
        // downward bias. The lower stiffness and damping create a soft, visible settle.
        const spring = 44 + settings.motion * 12;
        const damping = 9.4 + settings.motion * 1.8;
        p.vx += (-p.x * spring - p.vx * damping) * dt;
        p.vy += (-p.y * spring - p.vy * damping + 165) * dt;
        p.angularV += (-p.angle * spring * 0.82 - p.angularV * damping * 0.9) * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle += p.angularV * dt;

        const bounds = stageRef.current?.getBoundingClientRect();
        if (bounds) {
          const limitX = Math.max(8, bounds.width / 2 - 110);
          const limitY = Math.max(8, bounds.height / 2 - 106);
          let didHit = false;
          if (p.x < -limitX || p.x > limitX) {
            p.x = Math.max(-limitX, Math.min(limitX, p.x));
            p.vx = -p.vx * 0.6;
            p.vy *= 0.9;
            p.angularV += Math.sign(p.x) * Math.min(52, Math.abs(p.vx) * 0.08);
            didHit = true;
          }
          if (p.y < -limitY || p.y > limitY) {
            p.y = Math.max(-limitY, Math.min(limitY, p.y));
            p.vy = -p.vy * 0.58;
            p.vx *= 0.9;
            p.angularV += Math.min(60, Math.abs(p.vy) * 0.075);
            didHit = true;
          }
          if (didHit) {
            setImpact(true);
            setMood((current) => current === "idle" || current === "impact" ? "impact" : current);
            window.clearTimeout(impactTimer.current);
            impactTimer.current = window.setTimeout(() => {
              setImpact(false);
              setMood((current) => current === "impact" ? "idle" : current);
            }, 240);
          }
        }
        if (Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.angle) + Math.abs(p.vx) + Math.abs(p.vy) + Math.abs(p.angularV) < 0.045) {
          Object.assign(p, REST);
        }
        setPose({ ...p });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragging, settings.motion]);

  useEffect(() => () => {
    window.clearTimeout(statusTimer.current);
    window.clearTimeout(impactTimer.current);
  }, []);

  const setPoseNow = (next: Pose) => {
    poseRef.current = next;
    setPose({ ...next });
  };

  const resetStatusLater = (delay: number) => {
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setMood("idle"), delay);
  };

  const receiveImage = () => {
    window.clearTimeout(statusTimer.current);
    setMood("receiving");
    statusTimer.current = window.setTimeout(() => {
      setMood("success");
      const p = poseRef.current;
      setPoseNow({ ...p, vy: p.vy - 185, angularV: p.angularV + (Math.random() - 0.5) * 110 });
      statusTimer.current = window.setTimeout(() => setMood("idle"), 1400);
    }, 780);
  };

  const rejectImage = () => {
    window.clearTimeout(statusTimer.current);
    setMood("error");
    const p = poseRef.current;
    setPoseNow({ ...p, angularV: p.angularV + 125 });
    resetStatusLater(1000);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = stageRef.current?.getBoundingClientRect();
    const p = poseRef.current;
    pointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      grabX: event.clientX - ((bounds?.left ?? 0) + (bounds?.width ?? 0) / 2 + p.x),
      grabY: event.clientY - ((bounds?.top ?? 0) + (bounds?.height ?? 0) / 2 + p.y),
    };
    p.vx = 0;
    p.vy = 0;
    p.angularV = 0;
    setDragging(true);
    setMood("attention");
    window.clearTimeout(statusTimer.current);
  };

  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current.id !== event.pointerId) return;
    const now = performance.now();
    const previous = pointerRef.current;
    const dt = Math.max(0.008, (now - previous.at) / 1000);
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    const bounds = stageRef.current?.getBoundingClientRect();
    const p = poseRef.current;
    p.vx = p.vx * 0.28 + (dx / dt) * 0.72;
    p.vy = p.vy * 0.28 + (dy / dt) * 0.72;
    p.angle = Math.max(-32, Math.min(32, p.vx * 0.04 - p.vy * 0.014));
    p.angularV = Math.max(-220, Math.min(220, p.vx * 0.14 - p.vy * 0.05));
    if (bounds) {
      const limitX = Math.max(8, bounds.width / 2 - 110);
      const limitY = Math.max(8, bounds.height / 2 - 106);
      p.x = Math.max(-limitX, Math.min(limitX, event.clientX - bounds.left - bounds.width / 2 - previous.grabX));
      p.y = Math.max(-limitY, Math.min(limitY, event.clientY - bounds.top - bounds.height / 2 - previous.grabY));
    }
    pointerRef.current = { ...previous, x: event.clientX, y: event.clientY, at: now };
    setPose({ ...p });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current.id !== event.pointerId) return;
    pointerRef.current.id = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    resetStatusLater(500);
  };

  const nudge = () => {
    window.clearTimeout(statusTimer.current);
    setMood("attention");
    const p = poseRef.current;
    setPoseNow({ ...p, vx: p.vx + 620, vy: p.vy - 290, angularV: p.angularV + 95 });
    resetStatusLater(1000);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length > 0) receiveImage();
  };

  const squash = Math.min(0.14, (Math.abs(pose.vx) + Math.abs(pose.vy)) * 0.00013);
  const stretch = Math.min(0.12, Math.abs(pose.vy) * 0.00013);
  const transform = `translate3d(${pose.x}px, ${pose.y}px, 0) rotate(${pose.angle}deg)`;

  return (
    <main className="orb-demo">
      <header className="demo-header">
        <a className="demo-brand" href="/" aria-label="回到 PicBoard">
          <span className="demo-brand-mark">P</span>
          <span>PicBoard <i>/</i> Motion Lab</span>
        </a>
        <span className="demo-build-tag"><span /> 角色物理实时驱动</span>
      </header>

      <section className="demo-intro">
        <p className="demo-eyebrow">ANIME ORB · MOTION LAB</p>
        <h1>让角色小球动起来。</h1>
            <p className="demo-lede">原图拆成头发、脸和眼睛像素层，再接上拖拽惯性、轻微发梢迟滞和软碰撞。每一层都来自原图，没有补画新的五官或装饰。</p>
      </section>

      <section className="demo-layout" aria-label="小球动效演示和控制">
        <div className="demo-playground-card">
          <div className="playground-heading">
            <div><span className="section-kicker">LIVE PREVIEW</span><strong>交互舞台</strong></div>
            <span className={`state-pill ${dragging ? "is-live" : ""}`}><i />{dragging ? "抓取中" : "实时"}</span>
          </div>

          <div
            ref={stageRef}
            className={`orb-stage ${dragging ? "is-dragging" : ""} mood-${mood}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <div className="stage-grid" aria-hidden="true" />
            <div className="stage-orbit stage-orbit-one" aria-hidden="true" />
            <div className="stage-orbit stage-orbit-two" aria-hidden="true" />
            <div
              className={`demo-orb-wrap ${dragging ? "is-dragging" : ""} anim-${settings.animation}`}
              style={{ transform }}
              onPointerDown={startDrag}
              onPointerMove={movePointer}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="button"
              tabIndex={0}
              aria-label="按住并拖动角色小球，松开后观察惯性和边缘碰撞"
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") nudge(); }}
            >
              <AnimeOrb mood={mood} motion={settings.motion} speed={settings.speed} impact={impact} squash={squash} stretch={stretch} pose={pose} visibleParts={visibleParts} />
            </div>
            <span className="stage-crosshair stage-crosshair-a" aria-hidden="true" />
            <span className="stage-crosshair stage-crosshair-b" aria-hidden="true" />
            <div className="stage-hint"><span className="hint-dot" />按住拖动 · 撞到舞台边缘会弹回 · 也可以拖入图片</div>
          </div>

          <div className="demo-status-row" aria-live="polite">
            <span className="status-led" />
            <span>{dragging ? "抓取中 · 松手后保留当前速度" : STATUS[mood]}</span>
          </div>

          <div className="demo-actions">
            <button className="action-primary" onClick={nudge}><span>↗</span>模拟拖动</button>
            <button className="action-secondary" onClick={receiveImage}><span>↓</span>吞下一张图</button>
            <button className="action-quiet" onClick={rejectImage}>失败反馈</button>
          </div>
        </div>

        <aside className="demo-controls-card">
          <div className="controls-heading"><span className="section-kicker">CHARACTER TUNING</span><strong>分层与物理</strong></div>

          <div className="part-toggles" aria-label="独立控制角色切片">
            <span className="part-toggles-title">角色切片</span>
            <label><input type="checkbox" checked={visibleParts.hair} onChange={(event) => setVisibleParts((parts) => ({ ...parts, hair: event.target.checked }))} /><span>头发</span></label>
            <label><input type="checkbox" checked={visibleParts.face} onChange={(event) => setVisibleParts((parts) => ({ ...parts, face: event.target.checked }))} /><span>脸部</span></label>
            <label><input type="checkbox" checked={visibleParts.leftEye} onChange={(event) => setVisibleParts((parts) => ({ ...parts, leftEye: event.target.checked }))} /><span>左眼</span></label>
            <label><input type="checkbox" checked={visibleParts.rightEye} onChange={(event) => setVisibleParts((parts) => ({ ...parts, rightEye: event.target.checked }))} /><span>右眼</span></label>
            <small>可单独组合各个原图切片；眼睛保持原图位置。</small>
          </div>

          <label className="control-field">
            <span><b>待机动作</b><output>{settings.animation === "spark" ? "活泼" : settings.animation === "random" ? "俏皮" : "安静"}</output></span>
            <select value={settings.animation} onChange={(event) => setSettings((current) => ({ ...current, animation: event.target.value as BallAnimationMode }))}>
              <option value="rest">轻柔呼吸</option>
              <option value="random">俏皮游移</option>
              <option value="spark">星光活泼</option>
            </select>
          </label>

          <label className="control-field range-control">
            <span><b>物理弹性</b><output>{Math.round(settings.motion * 100)}%</output></span>
            <input type="range" min="0" max="1" step="0.05" value={settings.motion} onChange={(event) => setSettings((current) => ({ ...current, motion: Number(event.target.value) }))} />
            <small>调节拖拽后的回弹、扭转和碰撞力度</small>
          </label>

          <label className="control-field range-control">
            <span><b>动画速度</b><output>{settings.speed.toFixed(1)}×</output></span>
            <input type="range" min="0.5" max="2" step="0.1" value={settings.speed} onChange={(event) => setSettings((current) => ({ ...current, speed: Number(event.target.value) }))} />
            <small>调整呼吸、头发切片晃动和整体动作节奏</small>
          </label>

          <div className="engine-note"><span>◉</span><p><b>原图像素分层</b><br />现有图片只有睁眼素材。为避免补画眼后皮肤，眼睛锁定在原位；头发切片参与轻微惯性，脸部随整体软弹形变。</p></div>
        </aside>
      </section>

      <footer className="demo-footer"><span>原图切片 · 弹簧回复 · 重力偏置 · 角速度 · 边缘碰撞 · 软弹形变</span><span>本页只演示，不保存或上传拖入的文件</span></footer>
    </main>
  );
}
