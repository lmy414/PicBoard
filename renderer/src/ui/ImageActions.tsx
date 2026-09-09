import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppState, ImageRecord } from "../../../shared/image-board";
import { IconClose } from "./Icons";
type PanelAnchor = { left: number; top: number };
const hasBlockingDialog = () => Boolean(document.querySelector(".dialog-card"));
export function QuickActions({ state, selectedIds, source, anchor, showRemove, onClose, onUpdate, onError, onNotice, onCopy, onPrompt, onRename, onDelete }: { state: AppState; selectedIds: string[]; source: HTMLElement | null; anchor: PanelAnchor | null; showRemove: boolean; onClose: () => void; onUpdate: (state: AppState) => void; onError: (message: string) => void; onNotice: (message: string) => void; onCopy: (ids: string[]) => Promise<void>; onPrompt: (title: string, value?: string) => Promise<string | null>; onRename: (image: ImageRecord) => void; onDelete: (ids: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const target = source?.closest<HTMLElement>(".image-card, .library-card, .preview-card") ?? null;
  const copyBusyRef = useRef(false);
  const asideRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [editor, setEditor] = useState<"rename" | "category" | "classify" | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    if (!target) return;
    target.classList.add("actions-expanded");
    const trigger = target.querySelector(".card-more");
    trigger?.setAttribute("aria-expanded", "true");
    return () => {
      target.classList.remove("actions-expanded");
      trigger?.setAttribute("aria-expanded", "false");
    };
  }, [target]);
  useLayoutEffect(() => {
    previouslyFocusedRef.current = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const first = asideRef.current?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    first?.focus();
    return () => {
      const origin = previouslyFocusedRef.current;
      if (origin?.isConnected) origin.focus();
    };
  }, [source]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (hasBlockingDialog()) return;
      // Right-clicking an image is an action on that image. In particular, do
      // not let the capture-phase listener close the panel before the target's
      // context-menu handler can preserve an existing multi-selection.
      if (event.button !== 0 || document.querySelector(".canvas-viewport.hand-tool")) return;
      const target = event.target as HTMLElement | null;
      if (!asideRef.current?.contains(target as Node) && !target?.closest(".image-card, .library-card, .mini-map, .preview-card")) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || hasBlockingDialog()) return;
      event.preventDefault(); event.stopImmediatePropagation(); if (editor) { setEditor(null); setError(""); } else onClose();
    };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true); 
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true);  };
  }, [onClose, editor]);
  useEffect(() => { setEditor(null); setError(""); }, [source, selectedIds.join(",")]);
  const selected = selectedIds.map((id) => state.images[id]).filter(Boolean);
  const classify = async (categoryId: string) => { if (busy) return; setBusy(true); try { onUpdate(await window.imageBoard.classifyImages(selectedIds, categoryId)); onNotice("分类已保存"); onClose(); } catch (error) { setError(error instanceof Error ? error.message : "分类失败"); } finally { setBusy(false); } };
  const save = async () => {
    if (busy || !value.trim()) return;
    setBusy(true); setError("");
    try {
      const next = editor === "rename" ? await window.imageBoard.renameImage(selectedIds[0], value) : await window.imageBoard.createCategory(value);
      onUpdate(next); setEditor(null); setValue(""); onNotice("已保存");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  };
  const remove = async () => { if (busy) return; setBusy(true); try { let next = state; for (const id of selectedIds) next = await window.imageBoard.removeImageFromCanvas(id); onUpdate(next); onClose(); } catch (error) { onError(error instanceof Error ? error.message : "移除失败"); } finally { setBusy(false); } };
  const copy = async () => {
    if (busy || copyBusyRef.current) return;
    copyBusyRef.current = true;
    setBusy(true);
    try { await onCopy(selectedIds); }
    finally { copyBusyRef.current = false; setBusy(false); }
  };
  if (!target?.isConnected) return null;
  return createPortal(
    <aside ref={asideRef} role="region" aria-label="图片操作" className="quick-actions card-actions-expanded"
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => event.stopPropagation()}>
      {error && <p role="alert" className="action-error">{error}</p>}
      {editor === "classify" ? <>
        <div className="inline-heading"><button onClick={() => setEditor(null)}>‹ 返回</button><span>分类</span></div>
        <div className="category-grid">{state.categories.map((category) => <button key={category.id} disabled={busy} aria-pressed={selected.every((image) => image.categoryId === category.id)} onClick={() => void classify(category.id)}>{category.name}</button>)}
          <button className="new-category" disabled={busy} onClick={() => { setEditor("category"); setValue(""); }}>＋ 新分类</button>
        </div>
      </> : editor ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input aria-label={editor === "rename" ? "重命名" : "新分类"} autoFocus value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} />
        <div className="inline-heading"><button type="button" disabled={busy} onClick={() => { setEditor(null); setError(""); }}>取消</button><button disabled={busy || !value.trim()}>保存</button></div>
      </form> : <div className="inline-action-bar">
        <button disabled={busy} onClick={() => { setEditor("classify"); setError(""); }}>分类 ▾</button>
        <button disabled={busy} onClick={() => void copy()}>复制</button>
        {selected.length === 1 && <button disabled={busy} onClick={() => { setEditor("rename"); setValue(selected[0].fileName); setError(""); }}>重命名</button>}
        {showRemove ? <button className="inline-remove" title="从画布移除" disabled={busy} onClick={() => void remove()}>移除</button> : selected.length > 0 && selected.every((image) => image.status === "classified") && <button className="inline-remove" title="移到系统回收站" disabled={busy} onClick={() => onDelete(selectedIds)}>删除</button>}
      </div>}
    </aside>, target);
}
