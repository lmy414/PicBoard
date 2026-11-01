import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppState, ContentRecord } from "../../../shared/image-board";
import { contentTitle } from "../content/content-meta";
import { KindIcon } from "./ContentIcons";
import { IconClose } from "./Icons";

export type PanelAnchor = { left: number; top: number };

/** Where the actions were opened from; canvas-only items stay in canvas context. */
export type ContentActionContext = "canvas" | "library" | "page" | "history";

export interface ContentActionsProps {
  state: AppState;
  context: ContentActionContext;
  contentIds: string[];
  /** Node ids for the canvas-only items (group / remove); empty elsewhere. */
  nodeIds: string[];
  anchor: PanelAnchor;
  /** Feed from usePresence: the menu stays mounted through its exit. */
  motion: "enter" | "idle" | "exit";
  onClose: () => void;
  onUpdate: (state: AppState) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onOpen: (contentId: string) => void;
  onCopy: (contentIds: string[]) => void;
  onRename: (content: ContentRecord) => void;
  onDelete: (contentIds: string[]) => void;
  onRemoveNodes: (nodeIds: string[]) => void;
  onGroupIntoCanvas: (nodeIds: string[]) => void;
}

type Editor = "classify" | "category" | null;

/**
 * Content action menu, anchorable to any origin element (canvas node, library
 * card, history item, page button). It never renders inside the card itself so
 * large cards and small history rows share one layout.
 */
export function ContentActions(props: ContentActionsProps) {
  const { state, context, contentIds, nodeIds, anchor } = props;
  const [editor, setEditor] = useState<Editor>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const asideRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const selected = contentIds.map((id) => state.contents[id]).filter((content): content is ContentRecord => Boolean(content));
  const single = selected.length === 1 ? selected[0] : null;
  const classified = selected.some((content) => content.categoryId !== null);
  const canTouchNodes = context === "canvas" && nodeIds.length > 0;

  useLayoutEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = asideRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])');
    first?.focus();
    return () => {
      const origin = previouslyFocusedRef.current;
      if (origin?.isConnected) origin.focus();
    };
  }, []);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!asideRef.current?.contains(target as Node)) props.onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector(".dialog-card")) return;
      // During the exit the menu is inert: let the page underneath own Escape.
      if (props.motion === "exit") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (editor) { setEditor(null); setError(""); }
      else props.onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [editor, props.motion, props.onClose]);

  const classify = async (categoryId: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      props.onUpdate(await window.imageBoard.classifyContents(contentIds, categoryId));
      props.onNotice(categoryId === null ? "已取消分类" : "分类已保存");
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "分类失败");
    } finally {
      setBusy(false);
    }
  };

  const createCategory = async () => {
    const name = value.trim();
    if (busy || !name) return;
    setBusy(true);
    setError("");
    try {
      const before = new Set(state.categories.map((category) => category.id));
      const next = await window.imageBoard.createCategory(name);
      props.onUpdate(next);
      const created = next.categories.find((category) => !before.has(category.id));
      if (created) {
        props.onUpdate(await window.imageBoard.classifyContents(contentIds, created.id));
        props.onNotice("分类已保存");
      } else {
        props.onNotice("已新建分类");
      }
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建分类失败");
    } finally {
      setBusy(false);
    }
  };

  const run = (action: () => void) => () => {
    if (busy) return;
    action();
    props.onClose();
  };

  return (
    <aside
      ref={asideRef}
      role="region"
      aria-label="内容操作"
      className="content-actions motion-pop"
      data-motion={props.motion}
      data-esc-layer
      style={{ left: anchor.left, top: anchor.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="content-actions-head">
        {single ? <><KindIcon kind={single.kind} size={13} /><span title={contentTitle(single)}>{contentTitle(single)}</span></> : <span>已选 {selected.length} 项</span>}
        <button type="button" className="content-actions-close" aria-label="关闭操作菜单" onClick={props.onClose}><IconClose size={12} /></button>
      </div>
      {error && <p role="alert" className="action-error">{error}</p>}
      {editor === "classify" ? (
        <>
          <div className="inline-heading"><button type="button" onClick={() => { setEditor(null); setError(""); }}>‹ 返回</button><span>分类</span></div>
          <div className="category-grid">
            {state.categories.map((category) => (
              <button
                key={category.id}
                type="button"
                disabled={busy}
                aria-pressed={selected.every((content) => content.categoryId === category.id)}
                onClick={() => void classify(category.id)}
              >
                {category.name}
              </button>
            ))}
            <button type="button" className="new-category" disabled={busy} onClick={() => { setEditor("category"); setValue(""); }}>＋ 新分类</button>
            {classified && <button type="button" className="clear-category" disabled={busy} onClick={() => void classify(null)}>取消分类</button>}
          </div>
        </>
      ) : editor === "category" ? (
        <form onSubmit={(event) => { event.preventDefault(); void createCategory(); }}>
          <input aria-label="新分类" autoFocus value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
          <div className="inline-heading">
            <button type="button" disabled={busy} onClick={() => { setEditor(null); setError(""); }}>取消</button>
            <button type="submit" disabled={busy || !value.trim()}>保存</button>
          </div>
        </form>
      ) : (
        <div className="content-action-list">
          {context !== "page" && selected.length === 1 && (
            <button type="button" onClick={run(() => props.onOpen(selected[0].id))}>打开</button>
          )}
          <button type="button" onClick={run(() => props.onCopy(contentIds))}>复制</button>
          <button type="button" onClick={() => { setEditor("classify"); setError(""); }}>分类 ▾</button>
          {single?.kind === "image" && (
            <button type="button" onClick={run(() => props.onRename(single))}>重命名</button>
          )}
          {canTouchNodes && (
            <button type="button" onClick={run(() => props.onGroupIntoCanvas(nodeIds))}>创建子画布</button>
          )}
          {canTouchNodes && (
            <button type="button" onClick={run(() => props.onRemoveNodes(nodeIds))}>从画布移除</button>
          )}
          <button type="button" className="danger-action" onClick={run(() => props.onDelete(contentIds))}>删除内容…</button>
        </div>
      )}
    </aside>
  );
}
