//! Custom listbox dropdown (controls lane). Contract:
//! `Select { value, onChange, options, label?, disabled? }`.
//!
//! The trigger keeps keyboard focus (WAI-ARIA activedescendant pattern) while
//! the popover renders a real `role="listbox"`. Chinese display labels come
//! from `options[].label`; internal ids are never shown as text. Keyboard:
//! ArrowDown/ArrowUp/Home/End move the highlight (without committing),
//! Enter/Space commit, Escape cancels and returns focus to the trigger. The
//! popup flips above when there is no room below and never clips (see
//! Popover.tsx). Options commit on pointer-down so the popover's outside-close
//! handling cannot swallow the click.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Popover, type PopoverCloseReason } from "./Popover";
import "./controls.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  label?: string;
  disabled?: boolean;
}

const HANDLED_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "];

function findIndex(options: SelectOption[], value: string): number {
  return options.findIndex((option) => option.value === value);
}

export function Select({ value, onChange, options, label, disabled }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openRef = useRef(open);
  const onChangeRef = useRef(onChange);
  openRef.current = open;
  onChangeRef.current = onChange;

  const selectedIndex = findIndex(options, value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const instanceId = useId();
  const listboxId = `qib-select-list-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const close = (reason: PopoverCloseReason) => {
    if (reason === "escape") triggerRef.current?.focus();
    setOpen(false);
    setHighlight(null);
  };

  // Seed the highlight from the current selection on open.
  useEffect(() => {
    if (!open || options.length === 0) return;
    setHighlight((current) => (current === null ? Math.max(0, selectedIndex) : current));
  }, [open, options.length, selectedIndex]);

  // Keep the highlighted option visible; never steal focus from the trigger.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const index = highlight === null ? Math.max(0, selectedIndex) : highlight;
      listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, highlight, selectedIndex]);

  const commit = (option: SelectOption) => {
    onChangeRef.current(option.value);
    setOpen(false);
    setHighlight(null);
  };

  const optionFor = (index: number): SelectOption | undefined => options[Math.max(0, Math.min(options.length - 1, index))];

  const triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!HANDLED_KEYS.includes(event.key)) return;
    event.preventDefault();
    const wasOpen = openRef.current;
    if (!wasOpen) setOpen(true);
    const last = Math.max(0, options.length - 1);
    const base = highlight ?? Math.max(0, selectedIndex);
    // First arrow press opens and lands on the current selection; further
    // presses move by one row.
    const delta = !wasOpen || event.key === "Home" || event.key === "End" ? 0 : event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const next = (() => {
      if (event.key === "Home") return 0;
      if (event.key === "End") return last;
      if (event.key === "Enter" || event.key === " ") return base;
      return Math.max(0, Math.min(last, base + delta));
    })();
    setHighlight(next);
    if (wasOpen && (event.key === "Enter" || event.key === " ")) {
      const option = optionFor(next);
      if (option) commit(option);
    }
  };

  const triggerClick = () => {
    if (disabled) return;
    if (openRef.current) close("escape");
    else setOpen(true);
  };

  const optionMouseDown = (event: MouseEvent<HTMLLIElement>, index: number) => {
    // Commit before the browser finishes the click so the outside-close
    // listener and the trigger's own focus handling stay out of the way.
    event.preventDefault();
    event.stopPropagation();
    const option = options[index];
    if (option) commit(option);
  };

  const highlightIndex = highlight === null ? Math.max(0, selectedIndex) : highlight;

  return (
    <div className={`qib-field ${disabled ? "qib-disabled" : ""}`}>
      {label && <span className="qib-label">{label}{disabled && <span className="qib-disabled-note">（当前不可更改）</span>}</span>}
      <button
        ref={triggerRef}
        type="button"
        className="qib-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={triggerClick}
        onKeyDown={triggerKeyDown}
      >
        <span className="qib-select-value">{selected ? selected.label : "—"}</span>
        <svg className={`qib-arrow ${open ? "qib-arrow-open" : ""}`} viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 5.5 7 9l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {!disabled && (
        <Popover
          open={open}
          anchor={triggerRef.current}
          onClose={close}
          panelProps={{
            role: "listbox",
            id: listboxId,
            "aria-label": label ?? "选项",
            "aria-activedescendant": options[highlightIndex] ? `qib-option-${options[highlightIndex]?.value}` : undefined,
          }}
        >
          <ul ref={listRef} className="qib-listbox">
            {options.map((option, index) => (
              <li
                key={option.value}
                data-index={index}
                id={`qib-option-${option.value}`}
                role="option"
                aria-selected={option.value === value}
                className={`qib-option ${index === highlightIndex ? "qib-highlight" : ""}`}
                onMouseDown={(event) => optionMouseDown(event, index)}
              >
                <span>{option.label}</span>
                <span className="qib-option-check" aria-hidden="true">✓</span>
              </li>
            ))}
            {options.length === 0 && <li className="qib-option qib-option-empty">没有可用选项</li>}
          </ul>
        </Popover>
      )}
    </div>
  );
}

export default Select;
