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
npm run dev:rust

# Electron 壳层（回滚入口）
npm run dev:electron        # 等同旧 npm run dev
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
