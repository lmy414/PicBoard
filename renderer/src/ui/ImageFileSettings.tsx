import { useEffect, useRef, useState } from "react";

interface AssociationStatus {
  available: boolean;
  registered: boolean;
}

export function ImageFileSettings() {
  const [status, setStatus] = useState<AssociationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        if (typeof window.imageBoard?.getImageAssociation !== "function") throw new Error("当前宿主未提供图片打开方式接口");
        const next = await window.imageBoard.getImageAssociation();
        if (!cancelled) setStatus(next);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "图片打开方式读取失败");
      }
    };
    void load();
    return () => { cancelled = true; mountedRef.current = false; };
  }, []);

  const configure = async () => {
    if (busy || !status?.available) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await window.imageBoard.configureImageAssociation();
      const next = await window.imageBoard.getImageAssociation();
      if (!mountedRef.current) return;
      setStatus(next);
      setMessage("已打开 Windows 默认应用设置。选择需要由 PicBoard 打开的图片类型。");
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "默认应用设置打开失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return <section className="settings-section" aria-label="默认图片打开器">
    <div className="settings-section-heading"><div><strong>默认图片打开器</strong><span>支持 PNG、JPEG、WebP、BMP 和 GIF，从资源管理器打开后可查看和编辑。</span></div></div>
    <p className="settings-note">点击下方按钮注册图片打开能力并打开 Windows 默认应用设置，再选择要交给 PicBoard 打开的图片类型。</p>
    <button type="button" className="small-button image-association-button" disabled={!status?.available || busy} onClick={() => void configure()}>{busy ? "正在打开…" : status?.registered ? "管理默认图片应用" : "设为默认图片应用"}</button>
    {!status && !error && <p className="qib-shell-note" role="status">正在读取图片打开方式…</p>}
    {status && !status.available && <p className="qib-shell-note">正式便携版可注册为图片查看器；开发版不修改系统文件关联。</p>}
    {status?.registered && <p className="qib-shell-note">PicBoard 已注册图片打开能力，默认关联由 Windows 中的选择决定。</p>}
    {error && <p className="qib-shell-error" role="alert">{error}</p>}
    {message && <p className="qib-shell-note" role="status">{message}</p>}
  </section>;
}
