//! In-app color picker (controls lane). Contract:
//! `ColorPicker { value, onChange, label?, disabled? }`, six-digit HEX only,
//! in-app popover (never the system color dialog).
//!
//! The SV square (saturation/value) and the hue strip are pointer-draggable
//! AND keyboard-controllable — the 2D area is never the only entry path. HEX
//! text is edited inline with a nearby error for invalid values; invalid
//! values are never written. Preview is live while interacting; `onChange`
//! fires only on explicit confirm (pointer/key release, Enter, preset click,
//! leaving the popover) so callers are not spammed per pixel — Esc reverts
//! the uncommitted preview to the last persisted value, and an outside click
//! commits only when the working value is valid. Layout classes are qib-
//! prefixed; see ./controls.css.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Popover, type PopoverCloseReason } from "./Popover";
import "./controls.css";

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
  disabled?: boolean;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const HUE_DEGREES = 12; // hue degrees per arrow-key press
const SV_STEP = 0.01; // SV fraction per arrow-key press

export function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function toHex(rgb: { r: number; g: number; b: number }): string {
  const c = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${c(rgb.r)}${c(rgb.g)}${c(rgb.b)}`.toLowerCase();
}

export function normalizeHex(input: string): string {
  const text = input.trim();
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return text.toLowerCase();
}

export function parseHex(value: string): { r: number; g: number; b: number } | null {
  if (!HEX_RE.test(value)) return null;
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const rgb = parseHex(hex);
  if (!rgb) return { h: 0, s: 0, v: 0 };
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const val = Math.max(0, Math.min(1, v));
  const chroma = val * sat;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb: { r: number; g: number; b: number };
  if (sector < 1) rgb = { r: chroma, g: x, b: 0 };
  else if (sector < 2) rgb = { r: x, g: chroma, b: 0 };
  else if (sector < 3) rgb = { r: 0, g: chroma, b: x };
  else if (sector < 4) rgb = { r: 0, g: x, b: chroma };
  else if (sector < 5) rgb = { r: x, g: 0, b: chroma };
  else rgb = { r: chroma, g: 0, b: x };
  const m = val - chroma;
  return toHex({ r: (rgb.r + m) * 255, g: (rgb.g + m) * 255, b: (rgb.b + m) * 255 });
}

const PRESET_HEXES = ["#ffffff", "#000000", "#e8483f", "#f08a24", "#f0b429", "#3ecf8e", "#2fbfa0", "#3b93f0", "#8b5cf6", "#e152b0", "#a3a3a3", "#8b5e3c"];

export function ColorPicker({ value, onChange, label, disabled }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  /** Working hex while the popover is open; committed only at confirm points. */
  const [draft, setDraft] = useState<string>(() => (isValidHex(value) ? value : "#000000"));
  /** Raw text of the HEX input (may be a partial/invalid edit in progress). */
  const [hexText, setHexText] = useState<string>("");
  const [invalidHex, setInvalidHex] = useState(false);
  const [hexFocused, setHexFocused] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const svPanelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const commitRef = useRef<string>(value); // last persisted hex (Esc revert target)
  const draftRef = useRef(draft); // latest draft for synchronous commit handlers
  const dragRef = useRef<{ mode: "sv" | "hue"; pointerId: number } | null>(null);
  const hexTextRef = useRef(hexText);
  const hexFocusedRef = useRef(hexFocused);
  openRef.current = open;
  valueRef.current = value;
  onChangeRef.current = onChange;
  hexTextRef.current = hexText;
  hexFocusedRef.current = hexFocused;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const instanceId = useId();
  const uid = instanceId.replace(/[^a-zA-Z0-9_-]/g, "");
  const hexInputId = `qib-color-hex-${uid}`;

  const fallbackHex = (): string => {
    const candidates = [commitRef.current, valueRef.current, "#000000"];
    for (const candidate of candidates) if (isValidHex(candidate)) return candidate.toLowerCase();
    return "#000000";
  };

  const persist = (hex: string) => {
    const normalized = normalizeHex(hex);
    if (!isValidHex(normalized)) return;
    if (normalized.toLowerCase() !== valueRef.current.toLowerCase()) onChangeRef.current(normalized);
    commitRef.current = normalized;
  };

  const applyDraft = (next: string, { syncHexText = false }: { syncHexText?: boolean } = {}): string | null => {
    const normalized = normalizeHex(next);
    if (!isValidHex(normalized)) return null;
    setDraft(normalized);
    // Keep the HEX box truthful: reflect non-typing changes (SV/hue) unless
    // the user is actively editing that field right now.
    if (syncHexText || !hexFocusedRef.current) setHexText(normalized);
    setInvalidHex(false);
    return normalized;
  };

  const openPanel = () => {
    if (disabled) return;
    const base = fallbackHex();
    commitRef.current = base;
    setDraft(base);
    setHexText(base);
    setInvalidHex(false);
    setOpen(true);
  };

  const closePanel = (reason: PopoverCloseReason, commit: boolean) => {
    if (commit) {
      // Outside click/focus-leave: persist only a legal working value.
      if (!invalidHex && isValidHex(draftRef.current)) persist(draftRef.current);
    } else {
      // Esc: drop the uncommitted preview and revert to the persisted value.
      const base = fallbackHex();
      commitRef.current = base;
      setDraft(base);
      setHexText(base);
      setInvalidHex(false);
    }
    setOpen(false);
  };

  const onPopoverClose = (reason: PopoverCloseReason) => {
    if (reason === "escape") {
      closePanel("escape", false);
      triggerRef.current?.focus();
    } else {
      closePanel(reason, true);
    }
  };

  // While closed, follow the caller's controlled value (reset etc.).
  useEffect(() => {
    if (openRef.current) return;
    if (value !== commitRef.current) commitRef.current = value;
    setDraft(isValidHex(value) ? value : "#000000");
    setHexText("");
    setInvalidHex(false);
  }, [value, open]);

  // --- SV square -----------------------------------------------------------

  const svFromPoint = (clientX: number, clientY: number): string | null => {
    const rect = svPanelRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return null;
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const hsv = hexToHsv(draftRef.current);
    return applyDraft(hsvToHex(hsv.h, s, v));
  };

  const svPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    svPanelRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { mode: "sv", pointerId: event.pointerId };
    svFromPoint(event.clientX, event.clientY);
  };
  const svPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.mode !== "sv" || dragRef.current.pointerId !== event.pointerId) return;
    svFromPoint(event.clientX, event.clientY); // live preview only
  };
  const releaseSv = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.mode !== "sv") return;
    event.preventDefault();
    const pointerId = dragRef.current.pointerId;
    dragRef.current = null;
    if (svPanelRef.current?.hasPointerCapture(pointerId)) svPanelRef.current.releasePointerCapture(pointerId);
    const hex = svFromPoint(event.clientX, event.clientY);
    if (hex) persist(hex); // release merges the preview into persistence
  };
  const cancelSv = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.mode !== "sv") return;
    dragRef.current = null;
    if (svPanelRef.current?.hasPointerCapture(event.pointerId)) svPanelRef.current.releasePointerCapture(event.pointerId);
    const base = fallbackHex();
    setDraft(base); // abort the drag: revert the preview, do not persist
    setHexText(base);
  };

  const svKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const hsv = hexToHsv(draftRef.current);
    const big = event.shiftKey ? SV_STEP * 10 : SV_STEP;
    const s =
      key === "ArrowRight" ? hsv.s + big :
      key === "ArrowLeft" ? hsv.s - big :
      key === "Home" ? 1 :
      key === "End" ? 0 : hsv.s;
    const v =
      key === "ArrowUp" ? hsv.v + big :
      key === "ArrowDown" ? hsv.v - big : hsv.v;
    const hex = applyDraft(hsvToHex(hsv.h, s, v));
    if (hex) persist(hex); // a keyboard step is an explicit confirm
  };

  // --- Hue strip -----------------------------------------------------------

  const hueFromValue = (raw: number): string | null => {
    const h = ((Math.round(raw) % 360) + 360) % 360;
    const hsv = hexToHsv(draftRef.current);
    return applyDraft(hsvToHex(h, hsv.s, hsv.v));
  };

  const hueKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const base = fallbackHex();
      commitRef.current = base;
      if (isValidHex(base) && base.toLowerCase() !== valueRef.current.toLowerCase()) onChangeRef.current(base);
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const hsv = hexToHsv(draftRef.current);
    const step = event.key === "Home" || event.key === "End" ? 360 : event.shiftKey ? HUE_DEGREES * 5 : HUE_DEGREES;
    const delta = event.key === "ArrowRight" || event.key === "ArrowUp" ? step : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : 0;
    const base = event.key === "Home" ? 0 : event.key === "End" ? 359 : hsv.h;
    const hex = hueFromValue(base + delta);
    if (hex) persist(hex); // arrow key on hue is an explicit confirm
  };

  const persistHueFromRelease = (event: React.PointerEvent<HTMLInputElement> | React.KeyboardEvent<HTMLInputElement>) => {
    const raw = Number((event.currentTarget as HTMLInputElement).value);
    const hex = hueFromValue(raw);
    if (hex) persist(hex); // drag/arrow release merges the preview
  };

  // --- HEX text ------------------------------------------------------------

  const hexChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setHexText(raw);
    const normalized = normalizeHex(raw);
    const valid = isValidHex(normalized);
    setInvalidHex(!valid && raw.length > 0);
    if (valid) setDraft(normalized);
  };

  const hexKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const normalized = normalizeHex(hexTextRef.current);
    if (isValidHex(normalized)) {
      setDraft(normalized);
      persist(normalized);
      closePanel("escape", false);
      triggerRef.current?.focus();
    }
  };

  const hexBlur = () => {
    setHexFocused(false);
    // Leaving the HEX field confirms a legal value or discards an invalid one.
    const normalized = normalizeHex(hexTextRef.current);
    if (isValidHex(normalized)) {
      setDraft(normalized);
      persist(normalized);
    } else if (invalidHex) {
      const base = fallbackHex();
      commitRef.current = base;
      setDraft(base);
      setHexText(base);
      setInvalidHex(false);
    }
  };

  // --- Presets -------------------------------------------------------------

  const selectPreset = (preset: string) => {
    applyDraft(preset, { syncHexText: true });
    persist(preset);
  };

  const hsv = hexToHsv(draft);
  const draftIsValid = isValidHex(draft);
  const svBackground = { backgroundColor: hsvToHex(hsv.h, 1, 1) };
  const svDot = { left: `${(hsv.s * 100).toFixed(1)}%`, top: `${((1 - hsv.v) * 100).toFixed(1)}%` };
  const hueThumb = { left: `${(hsv.h / 360) * 100}%` };

  return (
    <div className={`qib-field ${disabled ? "qib-disabled" : ""}`}>
      {label && (
        <span className="qib-label">
          {label}
          {disabled && <span className="qib-disabled-note">（当前不可更改）</span>}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="qib-color-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={openPanel}
      >
        <span className="qib-color-chip" style={{ backgroundColor: isValidHex(value) ? value : "#000000" }} aria-hidden="true" />
        <span className="qib-color-hex">{isValidHex(value) ? value.toLowerCase() : value}</span>
        <svg className={`qib-arrow ${open ? "qib-arrow-open" : ""}`} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 5.5 7 9l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {!disabled && (
        <Popover
          open={open}
          anchor={triggerRef.current}
          onClose={onPopoverClose}
          width={216}
          className="qib-color-popover"
          panelProps={{ role: "dialog", "aria-label": label ?? "选择颜色" }}
        >
          <div
            ref={svPanelRef}
            className="qib-sv-panel"
            role="slider"
            tabIndex={0}
            aria-label="饱和度与亮度"
            aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}%，亮度 ${Math.round(hsv.v * 100)}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            style={svBackground}
            onPointerDown={svPointerDown}
            onPointerMove={svPointerMove}
            onPointerUp={releaseSv}
            onPointerCancel={cancelSv}
            onKeyDown={svKeyDown}
          >
            <span className="qib-sv-dot" style={svDot} />
          </div>
          <div className="qib-color-row">
            <span className="qib-label">色相</span>
            <div className="qib-hue-slider">
              <div className="qib-hue-track" aria-hidden="true" />
              <span className="qib-hue-thumb" style={hueThumb} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={359}
                step={1}
                value={Math.round(hsv.h) % 360}
                aria-label="色相"
                onChange={(event) => hueFromValue(Number(event.target.value))}
                onKeyDown={hueKeyDown}
                onPointerUp={persistHueFromRelease}
                onKeyUp={persistHueFromRelease}
              />
            </div>
          </div>
          <div className="qib-hex-row">
            <label className="qib-label" htmlFor={hexInputId}>HEX</label>
            <input
              id={hexInputId}
              className={`qib-hex-input ${invalidHex ? "qib-invalid" : ""}`}
              value={hexText}
              spellCheck={false}
              autoComplete="off"
              onFocus={() => setHexFocused(true)}
              onChange={hexChange}
              onKeyDown={hexKeyDown}
              onBlur={hexBlur}
            />
            <span className="qib-hex-error">不是有效的六位 HEX</span>
            <span className="qib-preview-chip" style={{ backgroundColor: draftIsValid ? draft : "#000000" }} aria-hidden="true" />
          </div>
          <div className="qib-presets" role="group" aria-label="预设颜色">
            {PRESET_HEXES.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`qib-preset-swatch ${preset === draft ? "qib-selected" : ""}`}
                style={{ backgroundColor: preset }}
                title={preset}
                aria-label={`预设 ${preset}`}
                onClick={() => selectPreset(preset)}
              />
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

export default ColorPicker;
