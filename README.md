# 快捷图片画布

本项目是一个本地优先的桌面图片临时画布工具。

首期闭环：

> 悬浮窗 → 拖入或 Ctrl+V 粘贴 → 当前画布临时保留 → 点击图片快速分类 → 分类图片进入本地图片库

首期不包含服务器端和 SSH，图片数据保存在本机应用数据目录中。

## 开发

```powershell
npm install
```

两种壳层（数据格式与目录规则兼容）：

```powershell
# Rust/Tauri 壳层（推荐）：Vite + WebView2，自动使用隔离临时数据目录
npm run dev                # 默认 Rust；也可 npm run dev:rust
# 复用此前开发数据（否则每次创建新的隔离目录）
npm run dev:rust -- --data-root "C:\\你的开发数据目录"

# Electron 壳层（回滚入口）
npm run dev:electron
```

`npm run dev:rust` 会在系统临时目录创建本次运行的隔离数据根（不触碰真实用户
数据），并把路径打印在终端。详见 `docs/RUST-SHELL-MIGRATION.md`。

## 构建与检查

```powershell
npm run typecheck
npm run build
npm test
```

Rust 侧：

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

## Windows 便携包与桌面设置

本轮预览包：`release/quick-image-board-windows-20260907-234407.zip`（约 1.71 MB）。
解压后运行 `quick-image-board.exe`，需要系统已安装 Microsoft Edge WebView2 Evergreen Runtime。
这是未签名预览包，不是安装器；最终体验验收边界见 `docs/PHASE-1-ACCEPTANCE.md`。

- 设置 → 窗口与启动：关闭行为可选“收起为悬浮球”（默认）、“隐藏到托盘”、“退出应用”。
- 托盘菜单始终可打开画板、显示悬浮球或完全退出。
- 开机自启动默认关闭，仅发布版可用。请先把解压目录放在稳定位置；移动/删除程序前先关闭自启动。
- 目录选择只更新目录偏好，不自动迁移旧图片或改变实际数据根。
- 不要让 Electron 和 Rust 同时写入同一图片库。

重新生成便携包及 SHA256/体积报告：

```powershell
powershell -NoProfile -File scripts/package-portable.ps1
```

