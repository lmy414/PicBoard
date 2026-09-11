# PicBoard

Windows 本地优先的悬浮图片收集与整理工具。

看到有用的图片时，不必先整理文件夹，也不必立即决定分类：把图片拖到悬浮球，或在画板中按 `Ctrl+V`，图片就会进入当前画板。之后可以自由拖动、缩放、预览，等有时间时再分类归档。

PicBoard 不需要账号、服务器或云同步，图片和设置默认保存在本机。

## PicBoard 能帮你做什么

- 快速收集聊天、网页或其他应用中的图片。
- 在无限画布上临时摆放和整理图片。
- 为不同主题建立多个画板，例如“灵感”“素材”“待整理”。
- 稍后再把图片归入本地分类库，不打断当前工作。
- 预览大图、放大查看细节、批量选择图片。
- 将图片文件复制到剪贴板，粘贴到支持文件粘贴的其他应用中。
- 关闭并重新打开软件后，画板、图片和分类关系仍然保留。

## 快速开始

1. 下载并解压 Windows x64 便携包。
2. 运行 `PicBoard.exe`。
3. 点击悬浮球，打开画板。
4. 将图片拖到悬浮球或画板中；也可以复制图片后，在画板中按 `Ctrl+V`。
5. 在画布上整理图片，需要时再进行分类。

## 主要交互

### 悬浮球

| 操作 | 结果 |
| --- | --- |
| 短按 | 打开或收起画板 |
| 按住约 250ms 后拖动 | 移动悬浮球 |
| 将图片拖到悬浮球 | 快速收图，图片进入当前画板 |

### 画布

| 操作 | 结果 |
| --- | --- |
| 中键拖动 | 平移画布 |
| 按住 `Space` 后左键拖动 | 平移画布 |
| 鼠标滚轮 | 以鼠标位置为中心缩放画布，范围为 50%–150% |
| 拖动图片 | 调整图片在画布中的位置 |
| 点击“定位全部” | 将当前画布中的图片调整到可见区域 |
| 点击“＋” | 新建画布 |
| 点击画布标签 | 切换画布 |

### 选择、预览与分类

| 操作 | 结果 |
| --- | --- |
| 左键单击图片 | 打开快速预览 |
| `Shift` + 左键 | 增选或取消选择图片 |
| 在画布空白处拖动 | 框选图片 |
| 预览窗口内滚轮 | 放大或缩小预览图片 |
| 右键图片或点击“⋯” | 打开分类和操作菜单 |
| 选择分类 | 将图片归档到本地图片库，并保留在当前画布 |
| `Ctrl+C` | 复制预览图片或已选择图片的文件，可粘贴到其他应用 |
| `Delete` / `Backspace` | 从当前画布移除图片 |

从画布移除已分类图片时，只会移除画布上的引用，图片库中的原文件会保留。删除分类图片时，PicBoard 会将文件移到 Windows 回收站。删除画布前会确认；画布中的未分类临时图片会被清理，已分类图片仍会保留在图片库中。

## 下载与运行要求

请从 [GitHub Releases](https://github.com/lmy414/PicBoard/releases) 下载最新的 Windows x64 便携版。

- Windows 10/11 x64
- [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

PicBoard 当前是未签名便携版，不包含安装器和自动更新器。Windows 可能显示未知发布者提示。建议将解压后的文件夹放在稳定位置，再运行程序。

## 数据与隐私

PicBoard 是本地优先应用：

- 不需要账号。
- 不上传图片。
- 不提供云同步。
- 不依赖服务器运行。
- 图片、画板、分类和设置默认保存在当前 Windows 用户的数据目录中。

默认数据目录为：

```text
%APPDATA%\quick-image-board\quick-image-board
```

重要图片仍建议自行备份。设置中的路径偏好不会自动搬运已有图片。

## 开发与构建

### 开发环境

- Windows 10/11 x64
- Node.js 与 npm
- Rust 1.77.2 或更高版本
- Microsoft Edge WebView2 Evergreen Runtime

安装依赖：

```powershell
npm install
```

### 启动开发版本

Rust/Tauri 是当前唯一的桌面开发入口：

```powershell
npm run dev
```

开发启动默认使用独立的临时数据目录，不会触碰正式用户图片和设置。需要使用指定测试数据目录时，可以显式传入：

```powershell
npm run dev:rust -- --data-root "C:\path\to\picboard-test-data"
```

只调试前端渲染器时，也可以启动 Vite：

```powershell
npm run dev:renderer
```

### 检查与测试

```powershell
npm run typecheck
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

其中 `npm run build` 构建前端资源，`npm test` 会运行 Node、组件和 Rust 测试。

### 构建 Windows x64 便携版

在项目根目录执行：

```powershell
powershell -NoProfile -File scripts/package-portable.ps1
```

构建结果位于 `release/`，包括 Windows x64 便携 ZIP 和对应的校验清单。打包脚本会构建 Tauri/Rust 发布版本、收集第三方许可文件。发布包使用系统 WebView2，不包含固定版 WebView2，也不是签名安装器。

## 许可

PicBoard 源码采用 [MIT License](LICENSE)，Copyright © 2026 lmy414。

项目中的第三方组件和改编代码遵循各自的许可要求。相关许可文件会随源码或发布包提供；其中 Bloub 视觉组件的许可和署名见：

- [`renderer/src/third-party/bloub/LICENSE`](renderer/src/third-party/bloub/LICENSE)
- [`renderer/src/third-party/bloub/NOTICE.md`](renderer/src/third-party/bloub/NOTICE.md)

## 致谢

感谢 [Linux.do 社区](https://linux.do/) 提供交流、反馈与灵感。
