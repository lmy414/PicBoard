//! Directory picker field (controls lane). Contract:
//! `DirectoryField { label, value, onChange, disabled? }`.
//!
//! A path row with a readable text field (manual edits stay possible and go
//! through onChange) and a folder button opening the host native dialog via
//! `window.imageBoard.pickDirectory`. Cancelling returns null and leaves the
//! value untouched; an error from the host is shown next to the row and the
//! stored value is not modified. The label/notes around it must state this is
//! only a directory *preference* and that no files are moved (ui lane layout).

import { useId, useState } from "react";
import "./controls.css";

export interface DirectoryFieldProps {
  label: string;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}

/** Path shown at the start of the row; long paths ellipsize in the middle. */
export function midEllipsis(fullPath: string, maxLength: number): string {
  if (fullPath.length <= maxLength) return fullPath;
  const head = fullPath.slice(0, Math.max(1, Math.floor(maxLength * 0.42)));
  const tail = fullPath.slice(fullPath.length - Math.floor(maxLength * 0.42));
  return `${head}…${tail}`;
}

export function DirectoryField({ label, value, onChange, disabled }: DirectoryFieldProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const displayPath = value || "";

  const pick = async () => {
    if (disabled || busy) return;
    // native lane owns pickDirectory on the host surface (contract). The
    // shared type has not been extended yet (native lane file), so reach it
    // through a local intersection instead of shipping a stub implementation.
    const pickDirectory = (window.imageBoard as ImageBoardApiWithPickDirectory).pickDirectory;
    if (typeof pickDirectory !== "function") {
      setError("当前宿主未提供目录选择接口");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const selected = await pickDirectory(displayPath || undefined);
      if (selected !== null) onChange(selected); // cancel returns null: keep value
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "选择目录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qib-field">
      <label className="qib-label" htmlFor={inputId}>{label}</label>
      <div className="qib-directory-row">
        <input
          id={inputId}
          className={`qib-path-input ${error ? "qib-invalid" : ""}`}
          value={displayPath}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label}（完整路径，可编辑）`}
          title={displayPath || undefined}
          placeholder="可手动输入或点选文件夹"
          onChange={(event) => {
            setError("");
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          className="qib-pick-button"
          disabled={disabled || busy}
          title="打开系统目录选择器"
          onClick={() => void pick()}
        >
          {busy ? "选择中…" : "选择文件夹"}
        </button>
      </div>
      {error ? (
        <span className="qib-directory-status qib-error" role="alert">{error}</span>
      ) : (
        <span className="qib-directory-status">
          当前目录：<span className="qib-path-name" title={displayPath}>{displayPath ? midEllipsis(displayPath, 46) : "未设置"}</span>
        </span>
      )}
    </div>
  );
}

export default DirectoryField;

/** Local host contract while shared/image-board.ts is not yet extended. */
interface ImageBoardApiWithPickDirectory {
  pickDirectory?: (initialPath?: string) => Promise<string | null>;
}
