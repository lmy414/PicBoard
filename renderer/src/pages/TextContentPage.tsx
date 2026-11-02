import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MutableRefObject } from "react";
import { Editor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extension-placeholder";
import { SuggestionPluginKey, exitSuggestion } from "@tiptap/suggestion";
import type { SuggestionProps } from "@tiptap/suggestion";
import type { ContentAsset, ContentBody, ContentRecord } from "../../../shared/image-board";
import { assetRef, isHttpUrl } from "../content/content-meta";
import { exceedsBodyLimit, isPlainDoc, plainTextToDoc } from "./editor-doc";
import { ContentImage } from "./editor-image";
import { PASTE_SANITIZE_PATTERN, imageFileName, isImageFile, sanitizePastedHtml } from "./editor-assets";
import { SlashMenu, createSlashExtension } from "./editor-slash";
import type { SlashBridge, SlashItem, SlashMenuState } from "./editor-slash";
import { EditorBubbleMenu } from "./editor-bubble";
import type { BubbleApi } from "./editor-bubble";
import type { ContentLifecycle, ContentPageApi, ContentPageCallbacks, SaveStatus } from "./page-types";
import { usePresence } from "../ui/motion";
import { hostErrorMessage } from "./page-utils";
import "./editor.css";

export interface TextContentPageProps {
  content: ContentRecord;
  lifecycle: ContentLifecycle;
  apiRef: MutableRefObject<ContentPageApi>;
  callbacks: ContentPageCallbacks;
}

const SAVE_DEBOUNCE_MS = 600;

interface SavedSnapshot {
  text: string;
  html: string | null;
}

interface EditorRange {
  from: number;
  to: number;
}

type InsertTarget = number | EditorRange;

interface ImageItem {
  asset: ContentAsset;
  alt: string;
}

/** Editor output in the exact shape the host stores. */
function snapshotOf(editor: Editor, richRef: MutableRefObject<boolean>): ContentBody {
  const json = editor.getJSON();
  const plain = isPlainDoc(json);
  // Formatting (or any non-plain block) is an automatic promotion: once the
  // content has been rich, a later plain snapshot (removed marks, cleared
  // document) must not demote it again.
  if (!plain) richRef.current = true;
  return {
    // TipTap's default text serializer drops hard breaks; keep them as newlines
    // so plain content never loses Shift+Enter line breaks.
    text: editor.getText({
      blockSeparator: "\n",
      textSerializers: { hardBreak: () => "\n", image: () => "[图片]" },
    }),
    // The host treats `html: null` as plain text. A rich content therefore
    // keeps sending HTML even when the document is empty or only paragraphs;
    // otherwise typing the first plain character would demote it.
    html: plain && !richRef.current ? null : editor.getHTML(),
  };
}

/**
 * Notion-like text/rich-text page. Creates the editor only after the body
 * arrived, so the loaded document is the initial state (not an undo step) and
 * undo never wipes the content.
 */
export function TextContentPage({ content, lifecycle, apiRef, callbacks }: TextContentPageProps) {
  const [body, setBody] = useState<ContentBody | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const loading = !editor && !loadError;
  const skeletonPresence = usePresence(loading, 120);
  const slashPresence = usePresence(Boolean(slashMenu), 120);
  const lastSlashRef = useRef<SlashMenuState | null>(null);
  if (slashMenu) lastSlashRef.current = slashMenu;
  const editorRef = useRef<Editor | null>(null);
  const readyRef = useRef(false);
  const mountedRef = useRef(true);
  const contentIdRef = useRef(content.id);
  contentIdRef.current = content.id;
  // Richness is learned once and only promoted: the record kind, a loaded HTML
  // body or formatting all keep it true. Never let a stale text-kind update
  // sent before formatting demote an editor that has already gone rich.
  const richRef = useRef(content.kind === "richText");
  if (content.kind === "richText") richRef.current = true;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const lastSavedRef = useRef<SavedSnapshot | null>(null);
  const dirtyRef = useRef(false);
  const versionRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const oversizeNotifiedRef = useRef(false);
  const bubbleApiRef = useRef<BubbleApi | null>(null);
  const slashMenuRef = useRef<SlashMenuState | null>(null);
  const suggestionRef = useRef<SuggestionProps<SlashItem, SlashItem> | null>(null);
  const slashBridgeRef = useRef<SlashBridge | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const imageInsertTargetRef = useRef<InsertTarget | null>(null);
  const imagePickerRef = useRef<(editor: Editor, range: EditorRange) => void>(() => {});
  const imageHandlersRef = useRef<{
    handlePaste: (event: ClipboardEvent) => boolean;
  }>({
    handlePaste: () => false,
  });

  const applySaveStatus = useCallback((status: SaveStatus) => {
    if (!mountedRef.current) return;
    callbacksRef.current.onSaveStatus(status);
  }, []);

  const publishMenu = useCallback((next: SlashMenuState | null) => {
    slashMenuRef.current = next;
    setSlashMenu(next);
  }, []);

  if (!slashBridgeRef.current) {
    slashBridgeRef.current = {
      onStart(props) {
        suggestionRef.current = props;
        publishMenu({ items: props.items, index: 0, rect: props.clientRect?.() ?? null });
      },
      onUpdate(props) {
        suggestionRef.current = props;
        const current = slashMenuRef.current;
        const index = current ? Math.min(current.index, Math.max(0, props.items.length - 1)) : 0;
        publishMenu({ items: props.items, index, rect: props.clientRect?.() ?? null });
      },
      onExit() {
        suggestionRef.current = null;
        publishMenu(null);
      },
      onKeyDown(event) {
        const current = slashMenuRef.current;
        const suggestion = suggestionRef.current;
        if (!current || !suggestion || event.isComposing || current.items.length === 0) return false;
        if (event.key === "ArrowDown") {
          publishMenu({ ...current, index: (current.index + 1) % current.items.length });
          return true;
        }
        if (event.key === "ArrowUp") {
          publishMenu({
            ...current,
            index: (current.index - 1 + current.items.length) % current.items.length,
          });
          return true;
        }
        if (event.key === "Enter") {
          suggestion.command(current.items[current.index]);
          return true;
        }
        return false;
      },
      onPickImage(editor, range) {
        imagePickerRef.current(editor, range);
      },
    };
  }

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ["http", "https"],
          isAllowedUri: (url, context) => Boolean(url) && Boolean(context.defaultValidate(url)) && /^https?:\/\//i.test(url),
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      ContentImage,
      Placeholder.configure({ placeholder: "输入内容，或输入 / 插入块" }),
      createSlashExtension(slashBridgeRef),
    ],
    [],
  );

  // Load the body for this content; retry starts a fresh request.
  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setLoadError(null);
    window.imageBoard
      .getContentBody(content.id)
      .then((next) => {
        if (cancelled) return;
        setBody(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(hostErrorMessage(error, "无法载入内容"));
      });
    return () => {
      cancelled = true;
    };
  }, [content.id, reloadToken]);

  const performSave = useCallback(async () => {
    const instance = editorRef.current;
    if (!instance || !readyRef.current || !dirtyRef.current) return;
    const version = versionRef.current;
    const next = snapshotOf(instance, richRef);
    const saved = lastSavedRef.current;
    if (saved && saved.text === next.text && saved.html === next.html) {
      dirtyRef.current = false;
      applySaveStatus("saved");
      return;
    }
    if (exceedsBodyLimit(next.text, next.html)) {
      dirtyRef.current = false;
      applySaveStatus("error");
      if (!oversizeNotifiedRef.current) {
        oversizeNotifiedRef.current = true;
        callbacksRef.current.onError("内容过大，无法保存");
      }
      return;
    }
    oversizeNotifiedRef.current = false;
    applySaveStatus("saving");
    try {
      const state = await window.imageBoard.updateTextContent(contentIdRef.current, next);
      lastSavedRef.current = next;
      if (versionRef.current === version) {
        dirtyRef.current = false;
        applySaveStatus("saved");
      } else {
        applySaveStatus("saving");
      }
      callbacksRef.current.onState(state);
    } catch (error) {
      applySaveStatus("error");
      callbacksRef.current.onError(hostErrorMessage(error, "保存失败"));
    }
  }, [applySaveStatus]);

  const enqueueSave = useCallback((): Promise<void> => {
    const next = chainRef.current.then(performSave, performSave);
    chainRef.current = next;
    return next;
  }, [performSave]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void enqueueSave();
    }, SAVE_DEBOUNCE_MS);
  }, [enqueueSave]);

  const dismissSlash = useCallback((): boolean => {
    if (!suggestionRef.current && !slashMenuRef.current) return false;
    suggestionRef.current = null;
    const instance = editorRef.current;
    if (instance) exitSuggestion(instance.view, SuggestionPluginKey);
    publishMenu(null);
    return true;
  }, [publishMenu]);

  const dismissSlashRef = useRef(dismissSlash);
  dismissSlashRef.current = dismissSlash;

  const flush = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (lifecycle.discard || !dirtyRef.current) return;
    const version = versionRef.current;
    await enqueueSave();
    // Edits made while the request was in flight need one more pass.
    if (dirtyRef.current && versionRef.current !== version && !lifecycle.discard) {
      await enqueueSave();
    }
  }, [enqueueSave, lifecycle]);

  const updateFromEditor = useCallback(
    () => {
      dirtyRef.current = true;
      versionRef.current += 1;
      applySaveStatus("saving");
      scheduleSave();
    },
    [applySaveStatus, scheduleSave],
  );

  const updateRef = useRef(updateFromEditor);
  updateRef.current = updateFromEditor;

  function insertImageNodes(items: ImageItem[], target: InsertTarget | null) {
    const instance = editorRef.current;
    if (!instance || items.length === 0) return;
    const nodes = items.map(({ asset, alt }) => ({
      type: "image",
      attrs: {
        asset: assetRef(contentIdRef.current, asset.assetId),
        alt: alt || "图片",
        width: asset.width || null,
        height: asset.height || null,
      },
    }));
    const place = target ?? instance.state.selection.from;
    try {
      if (!instance.chain().focus().insertContentAt(place, nodes).run()) {
        instance.chain().focus().insertContent(nodes).run();
      }
    } catch {
      instance.chain().focus().insertContent(nodes).run();
    }
  }

  async function uploadImageFile(file: File): Promise<ContentAsset | null> {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      return await window.imageBoard.addContentAsset(contentIdRef.current, {
        name: file.name || imageFileName(file.type),
        data,
      });
    } catch (error) {
      callbacksRef.current.onError(hostErrorMessage(error, "图片插入失败"));
      return null;
    }
  }

  function insertImageFiles(files: File[], target: InsertTarget | null) {
    void (async () => {
      const items: ImageItem[] = [];
      for (const file of files) {
        const asset = await uploadImageFile(file);
        if (asset) items.push({ asset, alt: file.name });
      }
      insertImageNodes(items, target);
    })();
  }

  function insertPastedHtml(html: string, target: InsertTarget | null) {
    void (async () => {
      const contentId = contentIdRef.current;
      const result = await sanitizePastedHtml(html, contentId, async (decoded) => {
        try {
          return await window.imageBoard.addContentAsset(contentId, {
            name: imageFileName(decoded.mime),
            data: decoded.bytes,
          });
        } catch (error) {
          callbacksRef.current.onError(hostErrorMessage(error, "图片插入失败"));
          return null;
        }
      });
      if (result.unsupported > 0) {
        callbacksRef.current.onError(
          result.unsupported === 1 ? "一张图片格式不受支持，已跳过" : `${result.unsupported} 张图片格式不受支持，已跳过`,
        );
      }
      const instance = editorRef.current;
      if (!instance || !result.html.trim()) return;
      const place = target ?? instance.state.selection.from;
      try {
        if (!instance.chain().focus().insertContentAt(place, result.html).run()) {
          instance.chain().focus().insertContent(result.html).run();
        }
      } catch {
        instance.chain().focus().insertContent(result.html).run();
      }
    })();
  }

  function handlePasteImages(event: ClipboardEvent): boolean {
    const instance = editorRef.current;
    const clipboard = event.clipboardData;
    if (!instance || !clipboard) return false;
    const files = Array.from(clipboard.files).filter(isImageFile);
    if (files.length > 0) {
      event.preventDefault();
      insertImageFiles(files, { from: instance.state.selection.from, to: instance.state.selection.to });
      return true;
    }
    const html = clipboard.getData("text/html");
    if (html && PASTE_SANITIZE_PATTERN.test(html)) {
      event.preventDefault();
      insertPastedHtml(html, { from: instance.state.selection.from, to: instance.state.selection.to });
      return true;
    }
    return false;
  }

  function openImagePicker(instance: Editor, range: EditorRange) {
    instance.chain().focus().deleteRange(range).run();
    imageInsertTargetRef.current = instance.state.selection.from;
    const input = imageFileInputRef.current;
    if (input) {
      input.value = "";
      input.click();
    }
  }

  function handleImageInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).filter(isImageFile);
    const target = imageInsertTargetRef.current;
    imageInsertTargetRef.current = null;
    event.currentTarget.value = "";
    if (files.length > 0) insertImageFiles(files, target);
  }

  imagePickerRef.current = openImagePicker;
  imageHandlersRef.current = { handlePaste: handlePasteImages };

  // Creating the editor with the loaded document keeps reload out of history.
  useEffect(() => {
    if (!body) return;
    if (body.html !== null) richRef.current = true;
    let instance: Editor;
    try {
      instance = createEditor(body);
    } catch (error) {
      setLoadError(hostErrorMessage(error, "编辑器初始化失败"));
      return;
    }
    editorRef.current = instance;
    readyRef.current = true;
    lastSavedRef.current = snapshotOf(instance, richRef);
    dirtyRef.current = false;
    setEditor(instance);
    applySaveStatus("saved");

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      readyRef.current = false;
      editorRef.current = null;
      const pending = dirtyRef.current && !lifecycle.discard ? snapshotOf(instance, richRef) : null;
      const saved = lastSavedRef.current;
      instance.destroy();
      setEditor(null);
      if (pending && (!saved || saved.text !== pending.text || saved.html !== pending.html)) {
        void window.imageBoard
          .updateTextContent(contentIdRef.current, pending)
          .then((state) => {
            lastSavedRef.current = pending;
            callbacksRef.current.onState(state);
          })
          .catch((error: unknown) => {
            callbacksRef.current.onError(hostErrorMessage(error, "保存失败"));
          });
      }
    };
    // The editor is rebuilt only when a new body snapshot arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, extensions]);

  // Focus the body at its end once the editor is mounted so the user can type
  // immediately. This depends on the editor instance, not on content data:
  // later re-renders must not steal focus from the toolbar or move the caret.
  useEffect(() => {
    if (!editor) return;
    editor.commands.focus("end", { scrollIntoView: false });
  }, [editor]);

  function createEditor(initial: ContentBody): Editor {
    return new Editor({
      extensions,
      content: initial.html ?? plainTextToDoc(initial.text),
      editorProps: {
        attributes: {
          class: "cp-editor-content",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "内容编辑区",
          spellcheck: "true",
        },
        handleClick: (_view, _pos, event) => {
          const target = event.target;
          if (!(target instanceof Element)) return false;
          const anchor = target.closest("a");
          if (!anchor) return false;
          event.preventDefault();
          const href = anchor.getAttribute("href") ?? "";
          if ((event.ctrlKey || event.metaKey) && isHttpUrl(href)) {
            void window.imageBoard.openExternalUrl(href).catch((error: unknown) => {
              callbacksRef.current.onError(hostErrorMessage(error, "无法打开链接"));
            });
          }
          return true;
        },
        handlePaste: (_view, event) => imageHandlersRef.current.handlePaste(event),
        handleDOMEvents: {
          auxclick: (_view, event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("a")) return false;
            event.preventDefault();
            return true;
          },
          dragstart: (_view, event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("a")) return false;
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: () => updateRef.current(),
      onBlur: () => dismissSlashRef.current(),
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!slashMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (editorRef.current?.view.dom.contains(target)) return;
      if (target instanceof Element && target.closest(".cp-slash-menu")) return;
      dismissSlashRef.current();
    };
    const onLayoutChange = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cp-slash-menu")) return;
      dismissSlashRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onLayoutChange, true);
    window.addEventListener("resize", onLayoutChange as EventListener);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onLayoutChange, true);
      window.removeEventListener("resize", onLayoutChange as EventListener);
    };
  }, [slashMenu]);

  useEffect(() => {
    apiRef.current.flush = flush;
    apiRef.current.closePopups = () => dismissSlash() || (bubbleApiRef.current?.closePopups() ?? false);
    return () => {
      apiRef.current.flush = undefined;
      apiRef.current.closePopups = undefined;
    };
  }, [apiRef, dismissSlash, flush]);

  const pickSlashItem = (index: number) => {
    const current = slashMenuRef.current;
    const suggestion = suggestionRef.current;
    const item = current?.items[index];
    if (item && suggestion) suggestion.command(item);
  };

  const hoverSlashItem = (index: number) => {
    const current = slashMenuRef.current;
    if (current && current.index !== index) publishMenu({ ...current, index });
  };

  return (
    <div className="cp-text-page">
      <input
        ref={imageFileInputRef}
        className="cp-image-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        multiple
        hidden
        onChange={handleImageInput}
      />
      <div className="cp-editor-scroll">
        <div className="cp-editor-column">
          <div className="cp-editor-stage">
            {editor ? (
              <EditorContent editor={editor} className="cp-editor motion-fade" data-motion="enter" />
            ) : loadError ? (
              <div className="cp-editor-error motion-fade" data-motion="enter" role="alert">
                <strong>无法载入内容</strong>
                <p>{loadError}</p>
                <button type="button" className="cp-retry" onClick={() => setReloadToken((value) => value + 1)}>
                  重试
                </button>
              </div>
            ) : null}
            {skeletonPresence.mounted ? (
              <div
                className={`cp-editor-skeleton-layer${editor || loadError ? " is-overlay" : ""} motion-fade`}
                data-motion={skeletonPresence.phase}
                aria-busy={loading || undefined}
                aria-label={loading ? "内容载入中" : undefined}
                aria-hidden={!loading || undefined}
              >
                <div className="cp-editor-skeleton">
                  <span className="cp-skeleton-line cp-skeleton-title" />
                  <span className="cp-skeleton-line" />
                  <span className="cp-skeleton-line cp-skeleton-short" />
                  <span className="cp-skeleton-line" />
                  <span className="cp-skeleton-line cp-skeleton-short" />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {editor ? <EditorBubbleMenu editor={editor} apiRef={bubbleApiRef} /> : null}
      {editor && slashPresence.mounted && (slashMenu ?? lastSlashRef.current) ? (
        <SlashMenu
          menu={(slashMenu ?? lastSlashRef.current)!}
          phase={slashPresence.phase}
          onHover={hoverSlashItem}
          onPick={pickSlashItem}
        />
      ) : null}
    </div>
  );
}
