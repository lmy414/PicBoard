# PicBoard

**Windows 悬浮图片收集与本地画板。**

PicBoard 用一个常驻桌面的悬浮球快速接收图片。你可以把图片拖进来，或在展开的画板中按 `Ctrl+V` 粘贴，然后在多个画板上临时整理、预览和分类。图片与设置默认保存在本机，不需要账号，也不依赖服务器。

> 拖入或粘贴 → 画板整理 → 选择分类 → 本地保存

## 主要功能

- **悬浮球快速收集**：短点展开画板，长按或拖动移动悬浮球。
- **拖放与粘贴**：支持 PNG、JPEG、GIF、WebP 和 BMP；展开画板后可用 `Ctrl+V` 粘贴剪贴板图片。
- **多个本地画板**：创建、切换、重命名和删除画板，每个画板独立保存视角。
- **自由整理**：拖动画布平移、拖动图片定位、50%–150% 缩放，并可一键定位全部图片。
- **选择与预览**：左键打开预览；`Shift` + 左键增选或取消选择；在画布空白处拖动可框选图片。
- **预览细节查看**：预览窗口内滚轮可缩放（1×–8×），放大后可左键拖动查看细节，支持重置视图。
- **分类库操作**：右键图片打开分类和操作菜单；已分类图片可重命名，或发送到 Windows 系统回收站。
- **复制图片文件**：有预览时复制预览图片，否则复制显式选中的图片；按 `Ctrl+C` 可把图片文件复制到支持文件粘贴的应用。
- **托盘与关闭行为**：可选择关闭后收起为悬浮球、隐藏到托盘或完全退出。
- **可选开机自启动**：发布版支持当前 Windows 用户自启动，默认关闭。

## 下载与使用

前往 [GitHub Releases](https://github.com/lmy414/PicBoard/releases) 下载最新的 Windows x64 便携包：

```text
PicBoard-v0.1.1-windows-x64.zip
```

1. 将整个 ZIP 解压到一个稳定的本地目录。
2. 确认系统已安装 [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
3. 运行 `PicBoard.exe`。

PicBoard 当前提供的是**未签名便携版**，不是安装器，也没有自动更新器。Windows 可能显示未知发布者提示。若要启用开机自启动，请先把程序放到最终目录；移动或删除程序前先关闭自启动。

### 系统要求

- Windows 10/11 x64
- Microsoft Edge WebView2 Evergreen Runtime

WebView2 和 Windows 系统组件不会打包进 ZIP。

## 基本操作

| 操作 | 方法 |
|---|---|
| 展开画板 | 短点悬浮球 |
| 移动悬浮球 | 按住约 250ms，或按下后移动 |
| 导入图片 | 拖到悬浮球或展开的画板 |
| 粘贴图片 | 展开画板后按 `Ctrl+V` |
| 平移画布 | 中键拖动，或按住 `Space` 后左键拖动 |
| 移动图片 | 普通左键拖动图片 |
| 多选 | `Shift` + 左键单击，或在画布空白处拖动框选 |
| 快速预览 | 左键单击图片 |
| 预览缩放 | 预览窗口内滚轮；放大后左键拖动图片，按“重置”恢复 |
| 分类和操作菜单 | 右键单击图片 |
| 重命名图片 | 从右键菜单或预览窗口选择“重命名”；扩展名保持不变 |
| 复制图片文件 | 有预览时复制预览图片，否则复制显式选中图片；按 `Ctrl+C` |
| 从当前画板移除 | 悬停图片按 `Delete`；也可选择后按 `Delete` 或 `Backspace` |
| 从分类库删除 | 右键菜单或预览窗口选择“移到系统回收站” |

在分类库中，普通左键打开预览，`Shift` + 左键用于多选，右键打开分类和操作菜单。发送到系统回收站后，可在 Windows 回收站中恢复文件；但从系统回收站还原不会自动恢复 PicBoard 索引。

`Delete` 的画布目标优先级为：当前预览 > 鼠标悬停图片 > 显式选择；`Backspace` 为当前预览 > 显式选择。复制仍只认预览和显式选择，悬停不会改变 `Ctrl+C` 的目标。画布移除已分类图片只移除画布引用，分类库文件保留；未分类图片沿用原有临时文件删除逻辑，不保证进入系统回收站。

从预览打开分类菜单时，菜单定位在预览卡片附近；从菜单打开“新分类”输入框时，输入框定位在上一级菜单附近，并限制在窗口边界内。

在输入框中使用快捷键时，PicBoard 会保留正常的文本编辑行为。

本轮交互变更位于 `feat/ux-image-interactions` 开发分支，不代表 v0.1.1 下载包已更新。自动化测试不替代 Windows E2E；本轮最终真机交互验收由使用者执行，快速拖动/点击的稳定性尚未完成真机验收。

## 数据与隐私

PicBoard 是本地优先应用：当前版本没有账号、云图库、服务器同步或遥测服务。应用只会在用户主动操作时读取或写入剪贴板；启用自启动时会写入当前用户的 Windows `Run` 注册表项。

为兼容旧版本，默认数据目录继续使用：

```text
%APPDATA%\quick-image-board\quick-image-board
```

主要内容包括：

```text
state.json               画板、分类和图片索引
state.json.bak           状态备份
state.json.corrupt-*     损坏状态的保留副本（如发生恢复）
desktop-settings.json    关闭行为和自启动偏好
pending\                 尚未分类的临时图片
classified\              已分类图片
.trash\                  存储事务使用的回收目录
```

便携包目录不是默认图库目录。升级到 PicBoard v0.1.1 不会迁移或清空旧数据。重要图片仍建议自行备份。

设置中的目录选择目前只更新目录偏好，不会自动移动已有文件，也不会切换当前实际图库根目录。

## 窗口、托盘与自启动

关闭按钮支持三种行为：

- **收起为悬浮球**：默认行为，进程继续运行。
- **隐藏到托盘**：隐藏主窗口，可从托盘重新打开。
- **退出应用**：结束 PicBoard 进程。

托盘菜单始终提供“打开画板”“显示悬浮球”和“完全退出”。

开机自启动默认关闭，只在发布版中可用，并且仅在你明确切换设置时修改当前用户配置。开发模式不会注册系统自启动。

## 校验下载文件

每个 GitHub Release 同时提供 manifest，其中包含 ZIP 和包内文件的 SHA-256。可在 PowerShell 中校验：

```powershell
Get-FileHash .\PicBoard-v0.1.1-windows-x64.zip -Algorithm SHA256
```

输出应与 Release 页面和 `PicBoard-v0.1.1-windows-x64.manifest.json` 一致。

## 当前限制

- 当前发布目标为 Windows x64。
- 便携包未进行代码签名。
- 不包含安装器、自动更新器或固定版本 WebView2。
- 不提供云同步、账号系统或移动端。
- 不承诺所有剪贴板来源、混合 DPI 和多显示器组合都经过完整设备覆盖。
- 目前通过复制图片文件与其他应用交换内容，不提供从画板直接拖出文件。

如遇问题，请在 [GitHub Issues](https://github.com/lmy414/PicBoard/issues) 提交复现步骤、Windows 版本和显示缩放比例。

## 从源码运行

环境要求：

- Node.js 与 npm
- Rust 1.77.2 或更高版本
- Windows Tauri/WebView2 构建环境

```powershell
npm install
npm run dev
```

开发命令默认创建独立临时数据目录，不触碰正式用户库。需要复用指定测试数据时：

```powershell
npm run dev:rust -- --data-root "C:\path\to\picboard-test-data"
```

运行检查：

```powershell
npm test
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

生成 Windows x64 便携包：

```powershell
powershell -NoProfile -File scripts/package-portable.ps1
```

脚本会重新构建 Rust/Tauri 应用、收集第三方许可证、生成 ZIP 和 manifest、计算 SHA-256，并检查压缩包是否低于 50 MB。

## License

PicBoard 源码采用 [MIT License](LICENSE)，Copyright © 2026 lmy414。

第三方组件及改编代码遵循各自许可证。发布包中的 `licenses` 目录包含依赖许可清单；Bloub 视觉组件的原始许可与署名位于：

- [`renderer/src/third-party/bloub/LICENSE`](renderer/src/third-party/bloub/LICENSE)
- [`renderer/src/third-party/bloub/NOTICE.md`](renderer/src/third-party/bloub/NOTICE.md)
