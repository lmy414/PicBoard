import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconClose, IconInfo } from "./Icons";

export type ToastKind = "success" | "error" | "info" | "warning";
export type ToastMessage = { id: string; kind: ToastKind; message: string };
export function toastChannel() {
  let seq = 0;
  return { next(kind: ToastKind, message: string): ToastMessage {
    return { id: `${kind}-${++seq}`, kind, message };
  } };
}

export function ToastView({ toast, dismissMs = 2000, onClose }: {
  toast: ToastMessage | null; dismissMs?: number; onClose: () => void;
}) {
  return toast ? <ToastItem key={toast.id} toast={toast} dismissMs={dismissMs} onClose={onClose} /> : null;
}

function ToastItem({ toast, dismissMs, onClose }: {
  toast: ToastMessage; dismissMs: number; onClose: () => void;
}) {
  const persistent = toast.kind === "error" || toast.kind === "warning";
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(toast.kind === "info" ? Math.max(3000, dismissMs) : dismissMs);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (persistent || hovered || focused || leaving) return;
    const start = performance.now();
    const timer = window.setTimeout(close, Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - start));
    };
  }, [persistent, hovered, focused, leaving, close]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onCloseRef.current(), 160);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!persistent) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"], [role="listbox"]')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persistent, close]);

  const Icon = toast.kind === "success" ? IconCheck : persistent ? IconAlertTriangle : IconInfo;
  return <div className={`qib-toast toast-${toast.kind} ${leaving ? "leaving" : ""}`}
    role={persistent ? "alert" : "status"} aria-live={persistent ? "assertive" : "polite"}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <Icon className="toast-icon" size={15} />
    <span className="toast-text">{toast.message}</span>
    <button className="toast-close" type="button" aria-label="关闭通知" onClick={close}><IconClose size={12} /></button>
  </div>;
}
