import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { Suggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import {
  IconBulletList,
  IconCode,
  IconOrderedList,
  IconParagraph,
  IconQuote,
  IconTable,
  IconToDo,
  KindIcon,
} from "../ui/ContentIcons";
import { IconMinus } from "../ui/Icons";

/** One block command offered by the "/" menu. */
export interface SlashItem {
  id: string;
  title: string;
  aliases: string[];
  hint: string;
  icon: ReactNode;
  /** The image item opens the host picker instead of running a plain command. */
  insertImage?: boolean;
  run: (editor: Editor, range: Range) => void;
}

const heading = (level: 1 | 2 | 3, title: string, aliases: string[], hint: string): SlashItem => ({
  id: `heading-${level}`,
  title,
  aliases,
  hint,
  icon: <span className="cp-slash-badge">{`H${level}`}</span>,
  run: (editor, range) => {
    editor.chain().focus().deleteRange(range).setHeading({ level }).run();
  },
});

const command = (id: string, title: string, aliases: string[], hint: string, icon: ReactNode, run: SlashItem["run"]): SlashItem => ({
  id,
  title,
  aliases,
  hint,
  icon,
  run,
});

export const SLASH_ITEMS: SlashItem[] = [
  command("paragraph", "正文", ["p", "text", "paragraph", "zw"], "普通段落", <IconParagraph size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).setParagraph().run();
  }),
  heading(1, "标题 1", ["h1", "heading", "biaoti"], "大标题"),
  heading(2, "标题 2", ["h2", "heading", "biaoti"], "中标题"),
  heading(3, "标题 3", ["h3", "heading", "biaoti"], "小标题"),
  command("bullet-list", "无序列表", ["ul", "list", "bullet", "liebiao"], "项目符号", <IconBulletList size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).toggleBulletList().run();
  }),
  command("ordered-list", "有序列表", ["ol", "list", "number", "liebiao"], "编号列表", <IconOrderedList size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).toggleOrderedList().run();
  }),
  command("task-list", "待办列表", ["todo", "task", "checkbox", "daiban"], "可勾选的任务", <IconToDo size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).toggleTaskList().run();
  }),
  command("blockquote", "引用", ["quote", "blockquote", "yinyong"], "引用段落", <IconQuote size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).toggleBlockquote().run();
  }),
  command("code-block", "代码块", ["code", "pre", "daima"], "等宽代码区域", <IconCode size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
  }),
  command("divider", "分割线", ["hr", "divider", "line", "fenge"], "横向分隔", <IconMinus size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).setHorizontalRule().run();
  }),
  command("table", "表格", ["table", "grid", "biaoge"], "3 × 3 表格", <IconTable size={16} />, (editor, range) => {
    editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  }),
  {
    ...command("image", "图片", ["img", "image", "tupian", "tp"], "插入本地图片", <KindIcon kind="image" size={16} />, (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
    }),
    insertImage: true,
  },
];

/** Filter by Chinese label and Latin aliases; an empty query lists everything. */
export function filterSlashItems(query: string): SlashItem[] {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      item.aliases.some((alias) => alias.toLowerCase().includes(needle)),
  );
}

/** Callbacks the Suggestion plugin forwards to the React menu. */
export interface SlashBridge {
  onStart(props: SuggestionProps<SlashItem, SlashItem>): void;
  onUpdate(props: SuggestionProps<SlashItem, SlashItem>): void;
  onExit(): void;
  onKeyDown(event: KeyboardEvent): boolean;
  onPickImage?(editor: Editor, range: Range): void;
}

export function createSlashExtension(holder: { current: SlashBridge | null }): Extension {
  return Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          items: ({ query }) => filterSlashItems(query),
          command: ({ editor, range, props }) => {
            if (props.insertImage) {
              holder.current?.onPickImage?.(editor, range);
              return;
            }
            props.run(editor, range);
          },
          render: () => ({
            onStart: (props) => holder.current?.onStart(props),
            onUpdate: (props) => holder.current?.onUpdate(props),
            onExit: () => holder.current?.onExit(),
            onKeyDown: ({ event }) => holder.current?.onKeyDown(event) ?? false,
          }),
        }),
      ];
    },
  });
}

export interface SlashMenuState {
  items: SlashItem[];
  index: number;
  /** Caret rectangle captured from the suggestion plugin, viewport coordinates. */
  rect: { left: number; top: number; right: number; bottom: number } | null;
}

export interface SlashMenuProps {
  menu: SlashMenuState;
  phase: "enter" | "idle" | "exit";
  onHover(index: number): void;
  onPick(index: number): void;
}

export function SlashMenu({ menu, phase, onHover, onPick }: SlashMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const active = menu.items.length > 0 ? Math.min(menu.index, menu.items.length - 1) : 0;

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu.rect) {
      setPosition(null);
      return;
    }
    const margin = 8;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left = menu.rect.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
    left = Math.max(margin, left);
    let top = menu.rect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, menu.rect.top - height - 6);
    }
    setPosition({ left, top });
  }, [menu]);

  useEffect(() => {
    const element = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return createPortal(
    <div
      ref={menuRef}
      className={`cp-slash-menu motion-pop${position ? "" : " cp-slash-measuring"}`}
      data-motion={phase}
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0 }}
      role="listbox"
      aria-label="插入内容块"
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={(event) => {
        // Ignore the incidental placement under a resting pointer; only an
        // actual pointer move may steal the keyboard selection.
        if (event.pointerType !== "mouse") return;
        const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
        if (!item) return;
        const index = Number(item.dataset.index);
        if (Number.isInteger(index)) onHover(index);
      }}
    >
      <div className="cp-slash-heading">插入内容块</div>
      {menu.items.length === 0 ? (
        <div className="cp-slash-empty">没有匹配的内容块</div>
      ) : (
        <div className="cp-slash-list">
          {menu.items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-index={index}
              className={`cp-slash-item${index === active ? " active" : ""}`}
              onClick={() => onPick(index)}
            >
              <span className="cp-slash-icon">{item.icon}</span>
              <span className="cp-slash-title">{item.title}</span>
              <span className="cp-slash-hint">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cp-slash-footer">
        <span>↑↓ 选择</span>
        <span>Enter 插入</span>
        <span>Esc 关闭</span>
      </div>
    </div>,
    document.body,
  );
}
