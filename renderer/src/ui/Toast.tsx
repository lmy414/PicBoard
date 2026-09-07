import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { IconAlertTriangle, IconCheck, IconClose, IconInfo } from "./Icons";

/**
 * Single toast channel for the UI lane (contract: `ui/Toast.tsx`).
 *
 * - Success/notice dismiss automatically after `dismissMs` (default 2s), with
 *   a ~160ms exit; hovering or focusing pauses the timer and leaving resumes.
 * - Errors require an explicit close (click / close button / Esc); they are
 *   never auto-dismissed.
 * - Toast keys (`id`) drive the timers, so identical consecutive messages
 *   restart the countdown instead of being deduplicated away.
 * - Only one toast renders at a time (a single feedback outlet), so toasts
 *   cannot overlap each other. If a toast is replaced while the previous one
 *   is leaving, the old exit never dismisses the new toast.
 */

export type ToastKind = "success" | "error" | "info" | "warning";
export type ToastMessage = { id: string; kind: ToastKind; message: string };

interface ToastViewProps {
  toast: ToastMessage | null;
  /** Auto-dismiss delay for success/info toasts (default 2000ms). */
  dismissMs?: number;
  /** Called after the leaving transition when the toast should be cleared. */
  onClose: () => void;
}

/** Monotonic per-channel id generator (module-level, avoids Date.now() reuse). */
export function toastChannel(): { next(kind: ToastKind, message: string): ToastMessage } {
  let seq = 0;
  return {
    next(kind, message) {
      seq += 1;
      return { id: `${kind}-${seq}`, kind, message };
    },
  };
}

function exitLeave(timeoutRef: MutableRefObject<number | null>, onClose: () => void, toast: ToastMessage | null, leavingIdRef: MutableRefObject<string | null>) {
  if (timeoutRef.current !== null) return;
  timeoutRef.current = window.setTimeout(() => {
    timeoutRef.current = null;
    // If the toast was replaced meanwhile, do not dismiss the replacement.
    if (toast && leavingIdRef.current === toast.id) onClose();
  }, 160);
}

function isPersistentToast(toast: ToastMessage | null): boolean {
  return toast?.kind === "error" || toast?.kind === "warning";
}

function toastMs(kind: ToastKind, dismissMs: number): number {
  // Plan 4.1/6.1: success 2s auto-dismiss; informational notices 3s;
  // errors and storage warnings persist until dismissed.
  return kind === "info" ? Math.max(dismissMs, 3000) : dismissMs;
}

export function ToastView({ toast, dismissMs = 2000, onClose }: ToastViewProps) {
  const [paused, setPaused] = useState(false);
  const [deadline, setDeadline] = useState<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);
  const leavingIdRef = useRef<string | null>(null);

  // (Re)start the auto-dismiss window whenever the toast identity changes.
  useEffect(() => {
    if (toast) {
      // Paused (hovered/focused) toasts keep their remaining time and resume
      // when the pointer/focus leaves, because the deadline effect re-arms on
      // every pause transition using the still-fresh deadline below.
      setDeadline(Date.now() + toastMs(toast.kind, dismissMs));
      leavingIdRef.current = null;
    } else {
      setDeadline(null);
      leavingIdRef.current = null;
    }
    return () => {
      if (leaveTimerRef.current !== null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id]);

  // Auto-dismiss only for success/info; errors and storage warnings persist.
  useEffect(() => {
    if (!toast || isPersistentToast(toast) || deadline === null || paused) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      leavingIdRef.current = toast.id;
      exitLeave(leaveTimerRef, onClose, toast, leavingIdRef);
      return;
    }
    const id = window.setTimeout(() => {
      leavingIdRef.current = toast?.id ?? null;
      exitLeave(leaveTimerRef, onClose, toast, leavingIdRef);
    }, remaining);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline, paused, toast?.id, toast?.kind]);

  const closeNow = () => {
    if (!toast || leavingIdRef.current === toast.id) return;
    leavingIdRef.current = toast.id;
    exitLeave(leaveTimerRef, onClose, toast, leavingIdRef);
  };

  // Esc closes persistent toasts (errors/warnings) by keyboard, unless a
  // dialog owns the topmost layer (dialogs close first).
  useEffect(() => {
    if (!toast || (toast.kind !== "error" && toast.kind !== "warning")) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A dialog owns the topmost layer: it closes first, this toast stays.
      if (document.querySelector(".dialog-backdrop")) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, select") || target.isContentEditable)) return;
      event.preventDefault();
      closeNow();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast?.id, toast?.kind]);

  if (!toast) return null;
  const isPersistent = isPersistentToast(toast);
  const leaving = leavingIdRef.current === toast.id;
  const Icon = toast.kind === "success" ? IconCheck : isPersistent ? IconAlertTriangle : IconInfo;
  return (
    <div
      className={`qib-toast toast-${toast.kind} ${leaving ? "leaving" : ""}`}
      role={isPersistent ? "alert" : "status"}
      aria-live={isPersistent ? "assertive" : "polite"}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onClick={isPersistent ? closeNow : undefined}
    >
      <Icon className="toast-icon" size={15} />
      <span className="toast-text">{toast.message}</span>
      <button className="toast-close" type="button" aria-label="关闭通知" onClick={closeNow}>
        <IconClose size={12} />
      </button>
    </div>
  );
}
