import { useId } from "react";
import type { AppState, DesktopSettings, DesktopSettingsPatch, GridSize, HistoryRetentionDays } from "../../../shared/image-board";
import type { CanvasAppearance, CanvasPattern } from "../canvas/canvas-appearance";
import { PluginsSection } from "../plugins/PluginsSection";
import { ColorPicker, isValidHex, toHex } from "./ColorPicker";
import { DirectoryField } from "./DirectoryField";
import { ImageFileSettings } from "./ImageFileSettings";
import { Select } from "./Select";
import { ShellSettings } from "./ShellSettings";
import { useThemePreference } from "./theme";
import "./settings-page.css";

export const SETTINGS_SECTIONS = [
  { id: "canvas", label: "画布", description: "背景图案、颜色、网格与对齐方式。", keywords: ["canvas", "背景", "网格", "外观", "颜色"] },
  { id: "clipboard", label: "剪贴板", description: "后台记录与历史保留策略。", keywords: ["clipboard", "复制", "历史", "记录", "保留"] },
  { id: "storage", label: "存储目录", description: "保存路径偏好，选择文件夹。", keywords: ["storage", "路径", "目录", "文件夹", "位置"] },
  { id: "window", label: "窗口与启动", description: "关闭行为与开机自启动。", keywords: ["window", "托盘", "关闭", "开机", "自启动"] },
  { id: "images", label: "默认图片打开器", description: "注册图片打开能力，在 Windows 中选择默认应用。", keywords: ["images", "图片", "打开方式", "注册", "默认应用", "关联"] },
  { id: "categories", label: "分类管理", description: "管理当前本地内容库的分类。", keywords: ["categories", "类别", "标签", "新建分类"] },
  { id: "plugins", label: "插件", description: "查看插件与处理节点接口。", keywords: ["plugins", "处理节点", "接口", "扩展"] },
  { id: "appearance", label: "外观", description: "选择浅色、黑夜或跟随系统。", keywords: ["appearance", "theme", "主题", "深色", "黑夜", "浅色", "系统"] },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export interface PathSettings {
  filePath: string;
}

export interface SettingsNavigationProps {
  section: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  query: string;
}

/** Search only filters the navigation; the parent owns the selected page. */
export function SettingsNavigation({ section, onSectionChange, query }: SettingsNavigationProps) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = SETTINGS_SECTIONS.filter((entry) => {
    const searchable = [entry.label, entry.description, ...entry.keywords].join(" ").toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  return (
    <nav className="settings-navigation" aria-label="设置项目">
      <span className="settings-navigation-label">设置项目</span>
      <div className="settings-navigation-list">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === section ? "settings-navigation-item active" : "settings-navigation-item"}
            aria-current={entry.id === section ? "page" : undefined}
            title={entry.description}
            onClick={() => onSectionChange(entry.id)}
          >
            <span className="settings-navigation-marker" aria-hidden="true" />
            <span>{entry.label}</span>
          </button>
        ))}
        {entries.length === 0 && <p className="settings-navigation-empty" role="status">没有匹配的设置项目，试试其他关键词。</p>}
      </div>
    </nav>
  );
}

export interface SettingsPageProps {
  section: SettingsSection;
  state: AppState;
  pathSettings: PathSettings;
  desktopSettings: DesktopSettings | null;
  canvasAppearance: CanvasAppearance;
  onPathSettingsChange(patch: Partial<PathSettings>): void;
  onCanvasAppearanceChange(patch: Partial<CanvasAppearance>): void;
  onAddCategory(): Promise<boolean>;
  onDesktopSettingsChange(patch: DesktopSettingsPatch): void;
}

const RETENTION_OPTIONS = [
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
  { value: "0", label: "永久保留" },
];
const GRID_OPTIONS = [
  { value: "16", label: "16" },
  { value: "24", label: "24" },
  { value: "32", label: "32" },
];
const PATTERN_OPTIONS: Array<{ value: CanvasPattern; label: string }> = [
  { value: "dots", label: "网点" },
  { value: "lines", label: "网格线" },
  { value: "none", label: "无" },
];
const CANVAS_BACKGROUND_PRESETS = [
  { hex: "#FBFBFA", label: "纸白" },
  { hex: "#E8ECF1", label: "雾灰" },
  { hex: "#FFFFFF", label: "纯白" },
  { hex: "#F1EEE6", label: "米色" },
  { hex: "#E4EAF2", label: "雾蓝" },
  { hex: "#2A313B", label: "石墨" },
];

const THEME_OPTIONS = [
  { value: "light", label: "浅色", description: "明亮清晰的界面" },
  { value: "dark", label: "黑夜", description: "适合低光环境" },
  { value: "system", label: "跟随系统", description: "随系统外观自动切换" },
] as const;

function colorChannels(value: string): number[] | null {
  if (!/^rgba?\(/i.test(value)) return null;
  const channels = value.match(/[\d.]+/g)?.map(Number);
  return channels && channels.length >= 3 && channels.every(Number.isFinite) ? channels : null;
}

function cssHex(value: string, fallback: string): string {
  if (isValidHex(value)) return value;
  const channels = colorChannels(value);
  return channels ? toHex({ r: channels[0], g: channels[1], b: channels[2] }) : fallback;
}

/** The controls show the actual defaults without overwriting saved custom colors. */
function canvasControlAppearance(appearance: CanvasAppearance): CanvasAppearance {
  const style = window.getComputedStyle(document.documentElement);
  const ink = style.getPropertyValue("--canvas-pattern-default").trim() || style.getPropertyValue("--canvas-pattern").trim();
  const channels = colorChannels(ink);
  return {
    ...appearance,
    background: appearance.backgroundCustomized ? appearance.background : cssHex(style.getPropertyValue("--surface-canvas").trim(), appearance.background),
    patternColor: appearance.inkCustomized ? appearance.patternColor : cssHex(ink, appearance.patternColor),
    patternOpacity: appearance.inkCustomized ? appearance.patternOpacity : channels?.[3] ?? appearance.patternOpacity,
  };
}

export function SettingsPage({ section, state, pathSettings, desktopSettings, canvasAppearance, onPathSettingsChange, onCanvasAppearanceChange, onAddCategory, onDesktopSettingsChange }: SettingsPageProps) {
  const headingId = useId();
  const { preference, resolvedTheme, setPreference } = useThemePreference();
  const canvasControls = section === "canvas" ? canvasControlAppearance(canvasAppearance) : canvasAppearance;
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];
  return <section className="settings-view settings-page" aria-labelledby={headingId}>
    <div className="settings-heading settings-page-heading">
      <div>
        <span className="settings-page-kicker">设置</span>
        <h1 id={headingId}>{current.label}</h1>
        <p>{current.description}</p>
        <p className="settings-page-guidance">在左侧选择设置项目，修改即时生效。</p>
      </div>
    </div>
    {section === "canvas" && (
      <section className="settings-section">
        <div className="settings-section-heading"><div><strong>画布</strong><span>背景图案、网格与对齐方式。</span></div></div>
        <div className="settings-row">
          <div className="settings-field">
            <label>图案</label>
            <div className="pattern-options" role="group" aria-label="画布图案">
              {PATTERN_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={canvasAppearance.pattern === option.value ? "active" : undefined}
                  aria-pressed={canvasAppearance.pattern === option.value}
                  onClick={() => onCanvasAppearanceChange({ pattern: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <Select value={String(desktopSettings?.gridSize ?? 24)} label="网格间距" disabled={!desktopSettings} options={GRID_OPTIONS} onChange={(value) => onDesktopSettingsChange({ gridSize: Number(value) as GridSize })} />
        </div>
        <div className="settings-row">
          <div className="settings-field settings-field-wide">
            <label>背景颜色</label>
            <div className="color-options">
              {CANVAS_BACKGROUND_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  type="button"
                  className={`color-swatch ${canvasControls.background.toUpperCase() === preset.hex ? "selected" : ""}`}
                  style={{ backgroundColor: preset.hex }}
                  title={preset.label}
                  aria-label={`背景${preset.label}`}
                  aria-pressed={canvasControls.background.toUpperCase() === preset.hex}
                  onClick={() => onCanvasAppearanceChange({ background: preset.hex })}
                />
              ))}
            </div>
          </div>
          <ColorPicker key={canvasAppearance.backgroundCustomized ? "custom-background" : resolvedTheme + "-background"} value={canvasControls.background} label="背景颜色" onChange={(hex) => onCanvasAppearanceChange({ background: hex })} />
        </div>
        <div className="settings-row">
          <ColorPicker key={canvasAppearance.inkCustomized ? "custom-ink" : resolvedTheme + "-ink"} value={canvasControls.patternColor} label="图案颜色" onChange={(hex) => onCanvasAppearanceChange({ patternColor: hex, ...(!canvasAppearance.inkCustomized ? { patternOpacity: canvasControls.patternOpacity } : null) })} />
          <label className="range-field"><span><b>图案浓度</b><output>{Math.round(canvasControls.patternOpacity * 100)}%</output></span><input type="range" min="0" max="0.6" step="0.02" value={canvasControls.patternOpacity} aria-label="图案浓度" onChange={(event) => onCanvasAppearanceChange({ patternOpacity: Number(event.target.value), ...(!canvasAppearance.inkCustomized ? { patternColor: canvasControls.patternColor } : null) })} /></label>
        </div>
        <label className="settings-toggle">
          <input type="checkbox" checked={desktopSettings?.snapToGrid ?? false} disabled={!desktopSettings} onChange={(event) => onDesktopSettingsChange({ snapToGrid: event.target.checked })} />
          <span><b>网格对齐</b><small>开启后拖动与放置会吸附到网格；按住 Alt 可临时切换。</small></span>
        </label>
        <p className="settings-note">背景颜色与图案只保存在本机；未手动选择背景时，画布使用默认的浅色底。网格间距与对齐用于画布操作。</p>
      </section>
    )}
    {section === "clipboard" && (
      <section className="settings-section">
        <div className="settings-section-heading"><div><strong>剪贴板</strong><span>后台记录与历史保留策略。</span></div></div>
        <label className="settings-toggle">
          <input type="checkbox" checked={desktopSettings ? desktopSettings.captureEnabled !== false : true} disabled={!desktopSettings} onChange={(event) => onDesktopSettingsChange({ captureEnabled: event.target.checked })} />
          <span><b>后台记录剪贴板</b><small>复制的文字、富文本、链接和图片会进入历史；暂停后不再新增。</small></span>
        </label>
        <div className="settings-row">
          <Select value={String(desktopSettings?.historyRetentionDays ?? 30)} label="历史保留时间" disabled={!desktopSettings} options={RETENTION_OPTIONS} onChange={(value) => onDesktopSettingsChange({ historyRetentionDays: Number(value) as HistoryRetentionDays })} />
        </div>
        <p className="settings-note">已放到画布上或已分类的内容不会被自动清理。</p>
      </section>
    )}
    {section === "storage" && (
      <section className="settings-section">
        <div className="settings-section-heading"><div><strong>存储目录</strong><span>只保存路径偏好，不会自动搬运或删除已有内容。</span></div></div>
        <div className="path-fields"><DirectoryField label="文件路径" value={pathSettings.filePath} onChange={(value) => onPathSettingsChange({ filePath: value })} /></div>
        <p className="settings-note">路径变更不会在当前版本执行迁移；现有数据仍由应用的本地存储目录保护。</p>
      </section>
    )}
    {section === "window" && (
      <section className="settings-section">
        <div className="settings-section-heading"><div><strong>窗口与启动</strong><span>关闭行为与开机自启动。</span></div></div>
        <ShellSettings />
      </section>
    )}
    {section === "categories" && (
      <section className="settings-section">
        <div className="settings-section-heading"><div><strong>分类管理</strong><span>分类会直接写入当前本地内容库。</span></div><button className="primary-button small-button" onClick={() => void onAddCategory()}>＋ 新建分类</button></div>
        <div className="category-list">{state.categories.map((category) => <span className="category-chip" key={category.id}>{category.name}</span>)}</div>
      </section>
    )}
    {section === "appearance" && <section className="settings-section" aria-label="外观设置">
      <div className="settings-section-heading"><div><strong>界面主题</strong><span>选择适合当前环境的明暗外观。</span></div></div>
      <div className="settings-theme-options" role="radiogroup" aria-label="界面主题">
        {THEME_OPTIONS.map((option) => <label className={preference === option.value ? "settings-theme-option selected" : "settings-theme-option"} key={option.value}>
          <input type="radio" name={headingId + "-theme"} value={option.value} checked={preference === option.value} aria-label={option.label} onChange={() => setPreference(option.value)} />
          <span className={"settings-theme-preview theme-preview-" + option.value} aria-hidden="true"><span /><i /></span>
          <span className="settings-theme-copy"><b>{option.label}</b><small>{option.description}</small></span>
        </label>)}
      </div>
      <p className="settings-note">当前使用{resolvedTheme === "dark" ? "黑夜" : "浅色"}外观。跟随系统会随 Windows 的外观自动切换。</p>
    </section>}
    {section === "images" && <ImageFileSettings />}
    {section === "plugins" && <PluginsSection />}
  </section>;
}
