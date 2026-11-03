import { useRef, useState, type ReactNode } from "react";
import { IconFit } from "./ContentIcons";
import { IconMagnet, IconMinus, IconPlus } from "./Icons";
import { Popover } from "./Popover";
import "./canvas-dock.css";

export type CanvasTool = "select" | "pan";
interface Props {
  tool: CanvasTool;
  onToolChange(tool: CanvasTool): void;
  onCreate(kind: "richText" | "link"): void;
  onImportImage(): void;
  onCreateCanvas(): void;
  historyOpen: boolean;
  onToggleHistory(): void;
  snapToGrid: boolean;
  onToggleSnap(): void;
  zoom: number;
  onZoom(delta: number): void;
  onLocateAll(): void;
  showViewControls: boolean;
  disabled: boolean;
}

function DockIcon({ kind }: { kind: "select" | "pan" | "text" | "link" | "image" | "history" | "keyboard" }) {
  const paths: Record<typeof kind, ReactNode> = {
    select: <path d="m5 3 13 9-6 1-3 6-4-16Z" />,
    pan: <><path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-1c-2 0-3-1-4-3l-4-5a1.5 1.5 0 0 1 2-2l1 1Z" /></>,
    text: <><path d="M5 6V4h14v2M12 4v16M8 20h8" /><path d="M16 11h4m-4 4h4m-4 4h4" /></>,
    link: <><path d="m10 13 4-4M8 15l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 2 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 1)" /></>,
    image: <><path d="M15 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9M17 3h6m-3-3v6M3 17l5-5 4 4 3-3 5 5" /><circle cx="8" cy="8" r="1.5" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" /></>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export function CanvasDock(props: Props) {
  const [viewExpanded, setViewExpanded] = useState(false);
  const [menu, setMenu] = useState<"add" | "shortcuts" | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const shortcutsRef = useRef<HTMLButtonElement>(null);
  const choose = (action: () => void) => { setMenu(null); action(); };
  return <div className="canvas-float-layer">
    {props.showViewControls && <div className={`canvas-view-dock floating-capsule${viewExpanded ? " is-expanded" : ""}`} role="toolbar" aria-label="画布视图">
      <button type="button" className="dock-view-toggle" aria-label={viewExpanded ? "收起视图工具" : "展开视图工具"} aria-expanded={viewExpanded} title={viewExpanded ? "收起缩放与网格工具" : "展开缩放与网格工具"} onClick={() => setViewExpanded((value) => !value)}><span className="dock-zoom">{Math.round(props.zoom * 100)}%</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={viewExpanded ? "m10 4-4 4 4 4" : "m6 4 4 4-4 4"} /></svg></button>
      {viewExpanded && <div className="canvas-view-details motion-fade" data-motion="enter">
        <span className="dock-separator" />
        <button type="button" className={props.snapToGrid ? "active" : ""} aria-label="网格对齐" title="网格对齐（Alt 临时反转）" aria-pressed={props.snapToGrid} onClick={props.onToggleSnap}><IconMagnet size={17} /></button>
        <button type="button" aria-label="缩小" title="缩小" onClick={() => props.onZoom(-0.1)}><IconMinus size={16} /></button>
        <button type="button" aria-label="放大" title="放大" onClick={() => props.onZoom(0.1)}><IconPlus size={16} /></button>
        <button type="button" aria-label="定位全部节点" title="定位全部节点" onClick={props.onLocateAll}><IconFit size={18} /></button>
      </div>}
    </div>}
    <div className="canvas-dock-position">
      <div className="canvas-dock floating-capsule" role="toolbar" aria-label="画板工具">
        <button ref={addRef} type="button" className="dock-add" aria-label="添加内容" title="添加内容 (Shift+A)" aria-expanded={menu === "add"} aria-haspopup="menu" disabled={props.disabled} onClick={() => setMenu(menu === "add" ? null : "add")}><IconPlus size={22} /></button>
        <span className="dock-separator" />
        <button type="button" aria-label="选择工具" title="选择 · 拖动空白框选" aria-pressed={props.tool === "select"} onClick={() => props.onToolChange("select")}><DockIcon kind="select" /></button>
        <button type="button" aria-label="平移工具" title="抓手 · 拖动画布（也可按住 Space）" aria-pressed={props.tool === "pan"} onClick={() => props.onToolChange("pan")}><DockIcon kind="pan" /></button>
        <button type="button" aria-label="新建富文本节点" title="富文本 · 文字、列表和图片" disabled={props.disabled} onClick={() => props.onCreate("richText")}><DockIcon kind="text" /></button>
        <button type="button" aria-label="新建链接节点" title="链接" disabled={props.disabled} onClick={() => props.onCreate("link")}><DockIcon kind="link" /></button>
        <button type="button" aria-label="导入图片到画布" title="导入图片到画布" disabled={props.disabled} onClick={props.onImportImage}><DockIcon kind="image" /></button>
        <span className="dock-separator" />
        <button type="button" aria-label={props.historyOpen ? "收起剪贴板历史" : "展开剪贴板历史"} title="剪贴板历史" aria-pressed={props.historyOpen} onClick={props.onToggleHistory}><DockIcon kind="history" /></button>
        <button ref={shortcutsRef} type="button" aria-label="快捷键帮助" title="快捷键帮助" aria-expanded={menu === "shortcuts"} aria-haspopup="dialog" onClick={() => setMenu(menu === "shortcuts" ? null : "shortcuts")}><DockIcon kind="keyboard" /></button>
      </div>
    </div>
    <Popover open={menu === "add"} anchor={addRef.current} onClose={() => setMenu(null)} width={208} className="dock-add-menu" panelProps={{ role: "menu", "aria-label": "添加到画布" }}>
      <button type="button" role="menuitem" onClick={() => choose(() => props.onCreate("richText"))}><DockIcon kind="text" />富文本节点</button>
      <button type="button" role="menuitem" onClick={() => choose(() => props.onCreate("link"))}><DockIcon kind="link" />链接节点</button>
      <button type="button" role="menuitem" onClick={() => choose(props.onImportImage)}><DockIcon kind="image" />导入图片</button>
      <button type="button" role="menuitem" onClick={() => choose(props.onCreateCanvas)}><IconPlus size={18} />子画布</button>
    </Popover>
    <Popover open={menu === "shortcuts"} anchor={shortcutsRef.current} onClose={() => setMenu(null)} width={286} className="dock-shortcuts" panelProps={{ role: "dialog", "aria-label": "画板快捷键" }}>
      <strong>画板快捷键</strong>
      <dl><div><dt>平移画布</dt><dd>Space + 拖动 / 中键</dd></div><div><dt>缩放</dt><dd>滚轮</dd></div><div><dt>添加内容</dt><dd>Shift + A / 右键</dd></div><div><dt>粘贴到画布</dt><dd>Ctrl + V</dd></div><div><dt>多选</dt><dd>Shift + 单击</dd></div><div><dt>打开内容</dt><dd>双击 / Enter</dd></div><div><dt>删除所选</dt><dd>Delete</dd></div><div><dt>返回上级</dt><dd>Esc</dd></div></dl>
    </Popover>
  </div>;
}
