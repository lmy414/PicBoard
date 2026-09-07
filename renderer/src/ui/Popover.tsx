//! Shared application popover shell (controls lane).
//!
//! Anchored content is rendered in a fixed layer on `document.body` so the
//! settings scroll container cannot clip it. Placement is measured from the
//! real DOM (no guessed heights): it flips above when there is not enough room
//! below, clamps inside the window, and re-measures when the panel or window
//! resizes. It closes on Escape, an outside pointer-down, an outside scroll,
//! or when focus leaves the panel. There is no full-screen backdrop, so a
//! click outside the panel lands where the user pointed instead of being
//! swallowed. Every qib- class here is styled in ./controls.css.

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import "./controls.css";

export type PopoverCloseReason = "escape" | "outside" | "scroll" | "focusout";

export interface PopoverPanelProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
}

export interface PopoverProps {
  open: boolean;
  /** Element the layer is anchored to (normally the trigger). */
  anchor: HTMLElement | null;
  /** Fired with the reason; the caller decides commit/cancel semantics. */
  onClose: (reason: PopoverCloseReason) => void;
  children: ReactNode;
  /** Fixed panel width; when omitted it follows the anchor (min 180px). */
  width?: number;
  /** Horizontal alignment relative to the anchor. */
  align?: "start" | "end";
  className?: string;
  /** Extra props for the measured panel element (role/aria/keyboard/ref). */
  panelProps?: PopoverPanelProps;
  /** Return focus to the anchor when closed via Escape. */
  restoreFocus?: boolean;
}

const EDGE = 8;
const GAP = 6;

export function Popover({
  open,
  anchor,
  onClose,
  children,
  width,
  align = "start",
  className = "",
  panelProps,
  restoreFocus = true,
}: PopoverProps) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const closedRef = useRef(false);
  anchorRef.current = anchor;
  onCloseRef.current = onClose;
  useEffect(() => {
    // One close per open cycle: a single user action can surface as several
    // events (pointer-down outside then focusout), keep the caller idempotent.
    if (!open) {
      closedRef.current = false;
      return;
    }
    closedRef.current = false;
  }, [open]);

  const attachPanel = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      const external = panelProps?.ref;
      if (!external) return;
      if (typeof external === "function") external(node);
      else (external as MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [panelProps?.ref],
  );

  const measure = useCallback(() => {
    const node = panelRef.current;
    const at = anchorRef.current;
    if (!node || !at) {
      setPlace(null);
      return;
    }
    const rect = at.getBoundingClientRect();
    const panelWidth = width ?? Math.max(rect.width, 180);
    // The render already fixes the width; keep it while measuring so the
    // measured height matches the visible layout.
    node.style.width = `${panelWidth}px`;
    const height = node.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const startX = align === "end" ? rect.right - panelWidth : rect.left;
    const left = Math.min(Math.max(EDGE, startX), Math.max(EDGE, vw - EDGE - panelWidth));
    const roomBelow = vh - EDGE - rect.bottom - GAP;
    const roomAbove = rect.top - EDGE - GAP;
    const flipAbove = height > roomBelow && height <= roomAbove;
    node.style.maxHeight = `${Math.max(0, vh - EDGE * 2)}px`;
    node.style.overflowY = "auto";
    const proposedTop = flipAbove ? rect.top - GAP - height : rect.bottom + GAP;
    const top = Math.max(EDGE, Math.min(proposedTop, vh - EDGE - node.offsetHeight));
    setPlace({ left: Math.round(left), top: Math.round(top) });
  }, [align, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
    const node = panelRef.current;
    if (!node) return;
    // Panel content can change height while open (inline errors, focus rings);
    // re-measure instead of guessing.
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    const onWindowResize = () => measure();
    window.addEventListener("resize", onWindowResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
    };
  }, [open, anchor, measure]);

  useEffect(() => {
    if (!open) return;
    const fireClose = (reason: PopoverCloseReason) => {
      if (closedRef.current) return;
      closedRef.current = true;
      if (reason === "escape" && restoreFocus) anchorRef.current?.focus({ preventScroll: true });
      onCloseRef.current(reason);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // Clicking the anchor again is the caller's toggle; do not pre-close.
      if (anchorRef.current?.contains(target)) return;
      fireClose("outside");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      fireClose("escape");
    };
    const handleScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      fireClose("scroll");
    };
    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!next) return;
      if (panelRef.current?.contains(next) || anchorRef.current?.contains(next)) return;
      fireClose("focusout");
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("focusout", handleFocusOut, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("focusout", handleFocusOut, true);
    };
  }, [open, restoreFocus]);

  if (!open || !anchor) return null;
  const panelWidth = width ?? Math.max(anchor.getBoundingClientRect().width, 180);
  const classes = ["qib-popover", className, place ? undefined : "qib-popover-measuring"]
    .filter(Boolean)
    .join(" ");
  const merged: PopoverPanelProps = {
    ...panelProps,
    ref: attachPanel,
    className: classes,
    style: { ...panelProps?.style, width: panelWidth },
  };
  return createPortal(
    <div className="qib-popover-layer" style={{ left: place?.left ?? 0, top: place?.top ?? 0 }}>
      <div {...merged}>{children}</div>
    </div>,
    document.body,
  );
}
