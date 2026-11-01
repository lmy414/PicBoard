import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { usePresence } from "../ui/motion";
import { isHttpUrl } from "../content/content-meta";
import { KindIcon } from "../ui/ContentIcons";

/** Imperative handle the page shell uses to close the URL popup on Esc. */
export interface BubbleApi {
  closePopups(): boolean;
}

interface MarkState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
}

const NO_MARKS: MarkState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: false,
};

interface BubblePosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Selection toolbar. `onMouseDown` is prevented on buttons so the editor keeps
 * its selection and focus; the link editor is the only focusable field.
 */
export function EditorBubbleMenu({ editor, apiRef }: { editor: Editor; apiRef: MutableRefObject<BubbleApi | null> }) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<BubblePosition>({ left: 0, top: 0, placement: "above" });
  const [marks, setMarks] = useState<MarkState>(NO_MARKS);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const presence = usePresence(visible, 120);
  const linkPresence = usePresence(linkMode, 120);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const linkModeRef = useRef(false);
  linkModeRef.current = linkMode;

  const hide = useCallback(() => {
    setVisible(false);
    setLinkMode(false);
    setLinkError("");
  }, []);

  useEffect(() => {
    const update = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || !editor.isEditable || !(editor.state.selection instanceof TextSelection)) {
        setVisible(false);
        setLinkMode(false);
        return;
      }
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const centerX = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2;
      const halfWidth = 170;
      const left = Math.max(halfWidth, Math.min(centerX, Math.max(halfWidth, window.innerWidth - halfWidth)));
      const top = Math.min(start.top, end.top);
      const placement: "above" | "below" = top > 88 ? "above" : "below";
      setPosition({
        left,
        top: placement === "above" ? top - 8 : Math.max(start.bottom, end.bottom) + 8,
        placement,
      });
      setMarks({
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        code: editor.isActive("code"),
        link: editor.isActive("link"),
      });
      setVisible(true);
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (editor.isDestroyed) return;
        const active = document.activeElement;
        if (bubbleRef.current?.contains(active)) return;
        if (active instanceof Node && editor.view.dom.contains(active)) return;
        if (linkModeRef.current) return;
        hide();
      }, 0);
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("blur", onBlur);
    update();
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("blur", onBlur);
    };
  }, [editor, hide]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (bubbleRef.current?.contains(target)) return;
      if (editor.view.dom.contains(target)) {
        if (linkModeRef.current) {
          setLinkMode(false);
          setLinkError("");
        }
        return;
      }
      hide();
    };
    const onLayoutChange = () => hide();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener("resize", onLayoutChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener("resize", onLayoutChange);
    };
  }, [editor, hide]);

  useEffect(() => {
    apiRef.current = {
      closePopups() {
        if (!linkModeRef.current) return false;
        setLinkMode(false);
        setLinkError("");
        return true;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (!linkMode) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [linkMode]);

  if (!presence.mounted) return null;

  const openLinkEditor = () => {
    const href = (editor.getAttributes("link").href as string | undefined) ?? "";
    setLinkValue(href);
    setLinkError("");
    setLinkMode(true);
  };

  const applyLink = () => {
    const raw = linkValue.trim();
    if (!raw) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkMode(false);
      setLinkError("");
      return;
    }
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (!isHttpUrl(normalized)) {
      setLinkError("请输入 http(s) 链接");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: normalized }).run();
    setLinkMode(false);
    setLinkError("");
  };

  return createPortal(
    <div
      ref={bubbleRef}
      className={`cp-bubble motion-fade is-${position.placement}${linkPresence.mounted ? " is-linking" : ""}`}
      data-motion={presence.phase}
      style={{ left: position.left, top: position.top }}
      role="toolbar"
      aria-label="文本格式"
    >
      {linkPresence.mounted ? (
        <div className="cp-bubble-link motion-slide-left" data-motion={linkPresence.phase}>
          <input
            ref={inputRef}
            className="cp-bubble-link-input"
            value={linkValue}
            placeholder="粘贴链接，回车确认"
            aria-label="链接地址"
            aria-invalid={Boolean(linkError)}
            onChange={(event) => {
              setLinkValue(event.target.value);
              if (linkError) setLinkError("");
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                setLinkMode(false);
                setLinkError("");
                editor.commands.focus();
              } else if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
            }}
          />
          <button
            type="button"
            className="cp-bubble-link-apply"
            title="应用链接"
            onMouseDown={(event) => event.preventDefault()}
            onClick={applyLink}
          >
            应用
          </button>
          {linkError ? <span className="cp-bubble-error">{linkError}</span> : null}
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`cp-bubble-button cp-bubble-bold${marks.bold ? " active" : ""}`}
            title="加粗 (Ctrl+B)"
            aria-label="加粗"
            aria-pressed={marks.bold}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            B
          </button>
          <button
            type="button"
            className={`cp-bubble-button cp-bubble-italic${marks.italic ? " active" : ""}`}
            title="斜体 (Ctrl+I)"
            aria-label="斜体"
            aria-pressed={marks.italic}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            I
          </button>
          <button
            type="button"
            className={`cp-bubble-button cp-bubble-underline${marks.underline ? " active" : ""}`}
            title="下划线 (Ctrl+U)"
            aria-label="下划线"
            aria-pressed={marks.underline}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            U
          </button>
          <button
            type="button"
            className={`cp-bubble-button cp-bubble-strike${marks.strike ? " active" : ""}`}
            title="删除线"
            aria-label="删除线"
            aria-pressed={marks.strike}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          >
            S
          </button>
          <span className="cp-bubble-separator" />
          <button
            type="button"
            className={`cp-bubble-button cp-bubble-code${marks.code ? " active" : ""}`}
            title="行内代码"
            aria-label="行内代码"
            aria-pressed={marks.code}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            {"</>"}
          </button>
          <button
            type="button"
            className={`cp-bubble-button${marks.link ? " active" : ""}`}
            title="链接"
            aria-label="链接"
            aria-pressed={marks.link}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openLinkEditor}
          >
            <KindIcon kind="link" size={14} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
