import { useEffect, useState } from 'react';

export function ImageFileSettings() {
  const [status, setStatus] = useState<{ available: boolean; registered: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { window.imageBoard.getImageAssociation?.().then(setStatus).catch((error) => setMessage(String(error))); }, []);
  const configure = async () => {
    setBusy(true); setMessage('');
    try { await window.imageBoard.configureImageAssociation(); setStatus(await window.imageBoard.getImageAssociation()); setMessage('已打开 Windows 默认应用设置。选择需要由 PicBoard 打开的图片类型。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '默认应用设置打开失败'); }
    finally { setBusy(false); }
  };
  return <section className="settings-section">
    <div className="settings-section-heading"><div><strong>图像打开方式</strong><span>支持 PNG、JPEG、WebP、BMP 和 GIF，从资源管理器打开后可查看和编辑。</span></div></div>
    <button type="button" className="small-button" disabled={!status?.available || busy} onClick={() => void configure()}>{busy ? '正在打开…' : status?.registered ? '管理默认图片应用' : '设为默认图片应用'}</button>
    {!status?.available && <p className="qib-shell-note">正式便携版可注册为图片查看器；开发版不修改系统文件关联。</p>}
    {message && <p className="qib-shell-note" role="status">{message}</p>}
  </section>;
}
