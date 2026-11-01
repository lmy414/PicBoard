import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AppState, ContentRecord } from "../../../shared/image-board";
import { isHttpUrl, linkDomain } from "../content/content-meta";
import { usePresence } from "../ui/motion";
import { IconCopy, IconEdit, IconExternalLink, KindIcon } from "../ui/ContentIcons";
import type { ContentPageApi } from "./page-types";
import { hostErrorMessage } from "./page-utils";

export interface LinkContentPageProps {
  content: ContentRecord;
  apiRef: MutableRefObject<ContentPageApi>;
  onState(state: AppState): void;
  onError(message: string): void;
  onNotice(message: string): void;
  onCopy(contentIds: string[]): void;
}

/**
 * Link page: details plus editing. Nothing is fetched: the WebView only stores
 * and hands the URL to the system browser on demand.
 */
export function LinkContentPage({ content, apiRef, onState, onError, onNotice, onCopy }: LinkContentPageProps) {
  const url = content.url ?? content.preview;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(url);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const editPresence = usePresence(editing, 120);
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const urlRef = useRef(url);
  editingRef.current = editing;
  urlRef.current = url;

  useEffect(() => {
    if (!editing) setValue(url);
  }, [url, editing]);

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError("");
    setValue(urlRef.current);
  }, []);

  useEffect(() => {
    apiRef.current.closePopups = () => {
      if (!editingRef.current) return false;
      cancelEdit();
      return true;
    };
    return () => {
      apiRef.current.closePopups = undefined;
    };
  }, [apiRef, cancelEdit]);

  const openLink = async () => {
    if (!isHttpUrl(url)) return;
    setOpening(true);
    try {
      await window.imageBoard.openExternalUrl(url);
    } catch (openError) {
      onError(hostErrorMessage(openError, "无法打开链接"));
    } finally {
      setOpening(false);
    }
  };

  const save = async () => {
    if (saving) return;
    const next = value.trim();
    if (!isHttpUrl(next)) {
      setError("请输入完整的 http(s) 链接");
      return;
    }
    if (next === url) {
      setEditing(false);
      setError("");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const state = await window.imageBoard.updateLinkContent(content.id, next);
      onState(state);
      setEditing(false);
      onNotice("链接已更新");
    } catch (saveError) {
      const message = hostErrorMessage(saveError, "保存失败");
      setError(message);
      onError(message);
    } finally {
      setSaving(false);
    }
  };

  const domain = linkDomain(url);
  const canOpen = isHttpUrl(url);

  return (
    <div className="cp-link-page">
      <div className="cp-link-card">
        <div className="cp-link-kind">
          <span className="cp-link-glyph" aria-hidden="true">
            <KindIcon kind="link" size={18} />
          </span>
          链接
        </div>
        <h1 className="cp-link-domain" title={domain}>
          {domain || "未命名链接"}
        </h1>
        {editPresence.mounted ? (
          <div className="cp-link-editor motion-slide-up" data-motion={editPresence.phase}>
            <label className="cp-link-editor-label" htmlFor="cp-link-input">
              链接地址
            </label>
            <div className="cp-link-editor-row">
              <input
                id="cp-link-input"
                ref={inputRef}
                className={`cp-link-input${error ? " has-error" : ""}`}
                value={value}
                placeholder="https://example.com"
                aria-invalid={Boolean(error)}
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
              />
              <button type="button" className="cp-link-primary" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              <button type="button" className="cp-link-secondary" onClick={cancelEdit} disabled={saving}>
                取消
              </button>
            </div>
            {error ? (
              <p className="cp-link-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="cp-link-hint">仅支持 http(s) 链接，保存后不会抓取网页内容。</p>
            )}
          </div>
        ) : (
          <div className="cp-link-read motion-fade" data-motion="enter">
            <p className={`cp-link-url${canOpen ? "" : " is-invalid"}`} tabIndex={0} title={url}>
              {url || "尚未设置链接"}
            </p>
            <div className="cp-link-actions">
              <button type="button" className="cp-link-primary" onClick={() => void openLink()} disabled={!canOpen || opening}>
                <IconExternalLink size={15} />
                {opening ? "正在打开…" : "在浏览器打开"}
              </button>
              <button type="button" className="cp-link-secondary" onClick={() => onCopy([content.id])}>
                <IconCopy size={14} />
                复制链接
              </button>
              <button type="button" className="cp-link-secondary" onClick={() => setEditing(true)}>
                <IconEdit size={14} />
                编辑
              </button>
            </div>
            {!canOpen ? <p className="cp-link-error">链接格式无效，请编辑为 http(s) 地址。</p> : null}
          </div>
        )}
        <p className="cp-link-note">PicBoard 只保存链接本身，不会加载或预览网页。</p>
      </div>
    </div>
  );
}
