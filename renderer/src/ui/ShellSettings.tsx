//! Desktop shell settings (controls lane). Contract: no required props; the
//! component reads and updates host settings itself and owns its loading and
//! failure handling. Compact layout for the Settings page.
//!
//! Host contract (native lane):
//!   getDesktopSettings(): Promise<{ closeBehavior: 'float'|'tray'|'quit';
//!                                    autoStart: boolean; autoStartAvailable: boolean }>
//!   setDesktopSettings(patch): Promise<DesktopSettings>
//!
//! Three mutually-exclusive close-behavior choices plus an auto-start switch,
//! shown only when the host reports it is available (dev builds never register
//! auto-start). Every host result is applied from what the host actually
//! persisted; nothing is faked. shared/image-board.ts is not extended yet
//! (native lane owns it), so the host is reached through a locally-declared
//! interface. No production stub ships: when the host methods are missing at
//! runtime, this component shows its own error state only.

import { useEffect, useRef, useState } from "react";
import type { ImageBoardApi } from "../../../shared/image-board";
import "./controls.css";

export type CloseBehavior = "float" | "tray" | "quit";

export interface DesktopSettings {
  closeBehavior: CloseBehavior;
  autoStart: boolean;
  autoStartAvailable: boolean;
}

/** Host surface this component relies on (contract with the native lane).
 *  Extends the declared imageBoard type so the runtime check plus cast stays
 *  honest: only the new methods are added locally until the shared type is
 *  extended by the native lane. */
export interface DesktopHostApi extends ImageBoardApi {
  getDesktopSettings(): Promise<DesktopSettings>;
  setDesktopSettings(patch: { closeBehavior?: CloseBehavior; autoStart?: boolean }): Promise<DesktopSettings>;
}

type HostWindow = Window & { imageBoard?: DesktopHostApi };

/** The global imageBoard is declared with the pre-extension ImageBoardApi
 *  type; reaching the desktop methods requires the narrower host view. */
const host = () => (window as unknown as HostWindow).imageBoard;

const CLOSE_OPTIONS: Array<{ value: CloseBehavior; label: string; hint: string }> = [
  { value: "float", label: "收起为悬浮球", hint: "关闭后保留小球" },
  { value: "tray", label: "隐藏到托盘", hint: "进程和托盘保留" },
  { value: "quit", label: "退出应用", hint: "结束全部进程" },
];

export function ShellSettings() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const api = host();
    if (typeof api?.getDesktopSettings !== "function") {
      setLoadError("当前宿主未提供桌面设置接口");
      return;
    }
    setLoadError("");
    api.getDesktopSettings()
      .then((loaded) => {
        if (mountedRef.current) setSettings(loaded);
      })
      .catch((caught) => {
        if (mountedRef.current) setLoadError(caught instanceof Error ? caught.message : "桌面设置读取失败");
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = async () => {
    const api = host();
    if (typeof api?.getDesktopSettings !== "function") return;
    setSettings(await api.getDesktopSettings());
  };

  const update = async (patch: { closeBehavior?: CloseBehavior; autoStart?: boolean }) => {
    const api = host();
    if (typeof api?.setDesktopSettings !== "function") {
      setLoadError("当前宿主未提供桌面设置接口");
      return;
    }
    setBusy(true);
    try {
      setSettings(await api.setDesktopSettings(patch));
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "桌面设置保存失败");
      // Reload so the UI never claims a change the host rejected.
      try {
        await reload();
      } catch {
        /* keep previous snapshot; error above stays visible */
      }
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setLoadError("");
    setBusy(true);
    try {
      await reload();
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "桌面设置读取失败");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="qib-shell-settings">
        <p className="qib-shell-error" role="alert">桌面设置不可用：{loadError}</p>
        <button type="button" className="qib-pick-button" onClick={() => void retry()}>重试</button>
      </div>
    );
  }

  if (!settings) {
    return <div className="qib-shell-settings"><p className="qib-shell-note">正在读取桌面设置…</p></div>;
  }

  const chooseCloseBehavior = (behavior: CloseBehavior) => {
    if (behavior === settings.closeBehavior || busy) return;
    void update({ closeBehavior: behavior });
  };

  const toggleAutoStart = (next: boolean) => {
    if (!settings.autoStartAvailable || busy || next === settings.autoStart) return;
    void update({ autoStart: next });
  };

  return (
    <div className="qib-shell-settings">
      <div>
        <span className="qib-choice-label">关闭窗口时</span>
        <div className="qib-close-choice" role="radiogroup" aria-label="关闭窗口时">
          {CLOSE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={settings.closeBehavior === option.value}
              disabled={busy}
              title={option.hint}
              onClick={() => chooseCloseBehavior(option.value)}
            >
              {option.label}
              <small>{option.hint}</small>
            </button>
          ))}
        </div>
      </div>
      <label className="qib-toggle-row">
        <input
          type="checkbox"
          checked={settings.autoStart}
          disabled={!settings.autoStartAvailable || busy}
          onChange={(event) => toggleAutoStart(event.target.checked)}
        />
        <span className="qib-switch" aria-hidden="true" />
        <span className="qib-toggle-copy">
          <b>开机自启动</b>
          <small>{settings.autoStartAvailable ? "登录 Windows 后自动启动快捷图片画布。" : "仅发布版可用；开发模式不会注册自启动。"}</small>
        </span>
      </label>
      <p className="qib-shell-note">关闭行为与自启动是独立的桌面偏好，不会移动或改变任何图片数据。</p>
    </div>
  );
}

export default ShellSettings;
