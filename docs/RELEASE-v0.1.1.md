# PicBoard v0.1.1

发布日期：2026-09-08

PicBoard 的首个公开版本。项目现以 MIT License 开源，并统一采用 PicBoard 产品名。

## 主要内容

- 仅保留 Rust/Tauri 桌面实现，移除旧 Electron 路线。
- 修复应用内刷新后 Renderer 与原生窗口展开状态分裂，导致界面缩成 88px 且无法恢复的问题。
- 修复 Windows 悬浮球拖动释放判断，避免拖动线程持续重复更新窗口位置。
- 加固启动可见性、线程 teardown、托盘隐藏/恢复、关闭行为和窗口几何。
- 加固 Windows 剪贴板 DIB 解码、像素边界和位掩码验证。
- 加固 Windows 偏好文件原子替换与损坏恢复路径。
- 扩展 Node 与 Rust 回归测试。

## Windows 便携包

- 资产：`PicBoard-v0.1.1-windows-x64.zip`
- Manifest：`PicBoard-v0.1.1-windows-x64.manifest.json`
- ZIP 大小：2,820,687 bytes（约 2.69 MiB）
- ZIP SHA-256：`95E96D0C6093C5A4CD42A38A587EBE409E71A6578735F204160C3B0AC7E0F33F`
- `PicBoard.exe` SHA-256：`20C633127316DE4C051D3589949B29A01ED2BFE108B131BA4B075293EE27468C`
- WebView2：使用系统 Microsoft Edge WebView2 Evergreen Runtime，不随包提供
- 签名：未签名

## 数据兼容

产品名称与可执行文件已改为 PicBoard。为了让旧版本用户直接升级，以下兼容标识暂时保留：

- 默认数据目录：`%APPDATA%\quick-image-board\quick-image-board`
- 原有本地偏好键
- Tauri 应用 identifier
- Windows 当前用户自启动注册表值名

v0.1.1 不会自动迁移、清空或重命名现有图库。

## 验证范围

发布前执行：

- Node 测试
- Rust 单元测试
- TypeScript 类型检查
- Vite 生产构建
- Cargo check
- ZIP/manifest 哈希与体积核对
- 解压后独立启动
- 刷新关键场景：悬浮球 → 展开 → `Ctrl+R` → 保持展开 → 收起 → 再展开

## 已知限制

- 仅发布 Windows x64 便携版。
- 未提供代码签名、安装器或自动更新。
- WebView2 不随包提供。
- 未宣称覆盖所有第三方剪贴板格式、混合 DPI 和多显示器硬件组合。
- 设置中的目录偏好不会自动迁移现有图片。
